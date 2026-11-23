import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { DATA, listFiles, readData, ROOT } from "../scripts/collect.ts";
import { absolute, generatedFiles } from "../scripts/generated.ts";
import { compileDataRegex, portabilityProblems } from "../src/portability.ts";
import { toRegexSpec } from "../src/schema/common.ts";
import type { RegexLike } from "../src/schema/common.ts";
import { testData } from "./helpers/rules.ts";

describe("generated files", () => {
  for (const [relative, expected] of generatedFiles()) {
    it(`${relative} is up to date (run npm run generate)`, () => {
      expect(readFileSync(absolute(relative), "utf8")).toBe(expected);
    });
  }
});

describe("data files match their JSON Schemas", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  // The string formats the schemas use; checked the same way zod checks them.
  ajv.addFormat(
    "date-time",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u,
  );
  ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/u);
  const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
  const schema = (name: string) => {
    let validate = compiled.get(name);
    if (validate === undefined) {
      validate = ajv.compile(
        JSON.parse(readFileSync(join(ROOT, "schema", name), "utf8")) as object,
      );
      compiled.set(name, validate);
    }
    return validate;
  };
  const groups: [string, string[]][] = [
    ["carriers.schema.json", [join(DATA, "carriers.yaml")]],
    ["keys.schema.json", [join(DATA, "keys.yaml")]],
    ["tracking-numbers.schema.json", listFiles(join(DATA, "tracking-numbers"), ".json")],
    ["status.schema.json", listFiles(join(DATA, "status"), ".yaml")],
    ["locale.schema.json", listFiles(join(DATA, "locales"), ".yaml")],
    ["mail-rule.schema.json", listFiles(join(DATA, "mail"), ".yaml")],
  ];
  for (const [schemaName, files] of groups) {
    const validate = schema(schemaName);
    for (const file of files) {
      it(`${basename(file)} matches ${schemaName}`, () => {
        expect(validate(readData(file)), JSON.stringify(validate.errors)).toBe(true);
      });
    }
  }

  it("the vendored files match the tracking-numbers schema too", () => {
    const validate = schema("tracking-numbers.schema.json");
    const vendor = listFiles(join(ROOT, "vendor", "tracking_number_data", "couriers"), ".json");
    const failing = vendor.filter((file) => !validate(readData(file)));
    expect(failing).toEqual([]);
  });
});

type TrackingType = ReturnType<
  typeof testData
>["bundle"]["tracking"][number]["courier"]["tracking_numbers"][number];

/** The `matches_regex` values of a format's lookup tables. */
function lookupRegexes(type: TrackingType): string[] {
  return (type.additional ?? [])
    .flatMap((additional) => additional.lookup)
    .map((row) => row["matches_regex"])
    .filter((regex): regex is string => typeof regex === "string");
}

/** Every regex written in our own data files, with where it came from. */
function dataRegexes(): { where: string; pattern: string; flags: readonly string[] }[] {
  const data = testData();
  const found: { where: string; pattern: string; flags: readonly string[] }[] = [];
  const add = (where: string, value: RegexLike, flags: readonly string[] = []) => {
    const spec = toRegexSpec(value);
    found.push({ where, pattern: spec.pattern, flags: spec.flags ?? flags });
  };
  for (const source of data.bundle.tracking.filter((s) => s.origin === "overlay")) {
    for (const type of source.courier.tracking_numbers) {
      const where = `${source.file} ${type.id ?? type.name}`;
      add(where, Array.isArray(type.regex) ? type.regex.join("") : type.regex);
      const prepend = type.validation.serial_number_format?.prepend_if.matches_regex;
      if (prepend !== undefined) add(`${where} prepend_if`, prepend);
    }
  }
  for (const carrier of data.bundle.carriers) {
    if (carrier.tracking_number_pattern !== undefined)
      add(`carriers/${carrier.id}`, carrier.tracking_number_pattern);
  }
  for (const file of data.status) {
    for (const entry of [...file.entries, ...file.ignore]) {
      if ("text" in entry.match)
        add(`status/${file.carrier}`, {
          pattern: entry.match.text,
          ...(entry.match.flags === undefined ? {} : { flags: entry.match.flags }),
        });
    }
  }
  // The lookup tables of our own formats.
  for (const source of data.bundle.tracking.filter((s) => s.origin === "overlay")) {
    for (const type of source.courier.tracking_numbers) {
      for (const regex of lookupRegexes(type)) {
        add(`${source.file} ${type.id ?? type.name} lookup`, regex);
      }
    }
  }
  for (const locale of data.locales) {
    for (const value of [...locale.negatives, ...locale.cut_markers])
      add(`locales/${locale.lang}`, value);
  }
  for (const rule of data.mail) {
    const where = `mail/${rule.id}`;
    for (const value of [...(rule.subject ?? []), ...(rule.exclude ?? [])])
      add(where, value, rule.flags);
    for (const specs of Object.values(rule.extract)) {
      for (const spec of specs)
        add(where, { pattern: spec.pattern, flags: spec.flags ?? rule.flags });
    }
    for (const group of [...rule.status_keywords, ...rule.event_keywords]) {
      for (const value of group.patterns) add(where, value, rule.flags);
    }
  }
  return found;
}

/**
 * The vendored formats' regexes. They are third-party data and use lookarounds, which both
 * engines of this package support, so they are held to "compiles in the JavaScript engine" here
 * (the Python vectors compile them in Python) rather than to the portable subset.
 */
function vendoredRegexes(): { where: string; pattern: string }[] {
  const found: { where: string; pattern: string }[] = [];
  for (const source of testData().bundle.tracking.filter((s) => s.origin !== "overlay")) {
    for (const type of source.courier.tracking_numbers) {
      const where = `${source.file} ${type.id ?? type.name}`;
      const regex = Array.isArray(type.regex) ? type.regex.join("") : type.regex;
      found.push({ where, pattern: toRegexSpec(regex).pattern });
      const prepend = type.validation.serial_number_format?.prepend_if.matches_regex;
      if (prepend !== undefined)
        found.push({ where: `${where} prepend_if`, pattern: toRegexSpec(prepend).pattern });
      found.push(...lookupRegexes(type).map((pattern) => ({ where: `${where} lookup`, pattern })));
    }
  }
  return found;
}

describe("vendored regexes", () => {
  it("all compile in the JavaScript engine", () => {
    const regexes = vendoredRegexes();
    expect(regexes.length).toBeGreaterThan(50);
    const failing = regexes.filter(({ pattern }) => {
      try {
        compileDataRegex(pattern, []);
        return false;
      } catch {
        return true;
      }
    });
    expect(failing).toEqual([]);
  });
});

describe("regex portability", () => {
  const regexes = dataRegexes();

  it("covers the ignore entries and lookup tables too", () => {
    const where = new Set(regexes.map((regex) => regex.where));
    const ignoreTexts = testData().status.flatMap((file) =>
      file.ignore.filter((entry) => "text" in entry.match).map(() => `status/${file.carrier}`),
    );
    expect(ignoreTexts.every((name) => where.has(name))).toBe(true);
  });

  it("finds the regexes it is meant to check", () => {
    expect(regexes.length).toBeGreaterThan(250);
  });

  it("keeps every data regex inside the portable subset", () => {
    const problems = regexes.flatMap(({ where, pattern }) =>
      portabilityProblems(pattern).map((problem) => `${where}: ${problem} in ${pattern}`),
    );
    expect(problems).toEqual([]);
  });

  it("compiles every data regex with the u flag and its own flags", () => {
    const failing = regexes.filter(({ pattern, flags }) => {
      try {
        compileDataRegex(pattern, flags);
        return false;
      } catch {
        return true;
      }
    });
    expect(failing).toEqual([]);
  });

  it("rejects each construct outside the subset", () => {
    expect(portabilityProblems("a(?=b)")).toContain("lookaround");
    expect(portabilityProblems("(?<!a)b")).toContain("lookaround");
    expect(portabilityProblems("(a)\\1")).toContain("backreference");
    expect(portabilityProblems("(?>ab)")).toContain("atomic group");
    expect(portabilityProblems("a++")).toContain("possessive quantifier");
    expect(portabilityProblems("abc\\Z")).toContain("\\Z anchor");
    expect(portabilityProblems("\\Aabc")).toContain("\\A anchor");
    expect(portabilityProblems("(?i)abc")).toContain("inline flags or unknown group syntax");
    expect(portabilityProblems("teslİm")).toContain("dotless ı or dotted İ");
    expect(portabilityProblems("(?P<n>a)")).toContain("(?P...) group syntax; write (?<name>...)");
    expect(portabilityProblems("a{,3}")).toContain("{,n} quantifier");
    expect(portabilityProblems("\\u00e4")).toContain("unsupported escape \\u");
  });

  it("accepts the constructs inside the subset", () => {
    for (const ok of [
      "(?<serial>[0-9]{3,4})",
      "a+?b*?",
      "[\\-a-z]",
      "^\\d+\\.\\s*$",
      "(?:x|y)",
      "\\x41",
    ]) {
      expect(portabilityProblems(ok)).toEqual([]);
    }
  });
});

describe("regex vectors", () => {
  const { cases } = JSON.parse(
    readFileSync(join(ROOT, "test", "fixtures", "regex-vectors.json"), "utf8"),
  ) as {
    cases: { pattern: string; flags?: string[]; input: string; matches: boolean }[];
  };

  it.each(cases)("$pattern on $input", ({ pattern, flags, input, matches }) => {
    expect(portabilityProblems(pattern)).toEqual([]);
    expect(compileDataRegex(pattern, flags).test(input)).toBe(matches);
  });
});
