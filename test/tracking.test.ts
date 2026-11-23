import { describe, expect, it } from "vitest";
import { detectTrackingNumbers } from "../src/index.ts";
import { verifyChecksum } from "../src/tracking/checksums.ts";
import { carrierOf, MAX_LINE, scanLines } from "../src/tracking/detect.ts";
import { withoutEdgeSpaces } from "../src/tracking/compile.ts";
import { matchType } from "../src/tracking/validate.ts";
import { testRules } from "./helpers/rules.ts";

const rules = testRules();

describe("tracking-number vectors (vendored and overlay)", () => {
  for (const type of rules.types) {
    const label = `${type.origin} ${type.courierCode}/${type.id}`;
    const { valid, invalid } = type.spec.test_numbers;

    it(`${label}: every valid test number validates`, () => {
      expect(valid.length).toBeGreaterThan(0);
      const failures = valid.filter((number) => matchType(type, number)?.valid !== true);
      expect(failures).toEqual([]);
    });

    it(`${label}: no invalid test number validates`, () => {
      const failures = invalid.filter((number) => matchType(type, number)?.valid === true);
      expect(failures).toEqual([]);
    });
  }

  it("covers every vendored courier file and the overlay", () => {
    const origins = new Set(rules.types.map((type) => `${type.origin}:${type.courierCode}`));
    expect(origins.size).toBeGreaterThanOrEqual(24);
    for (const code of ["dhl", "hermes", "gls", "postnl", "amazon", "dpd"]) {
      expect(origins.has(`overlay:${code}`)).toBe(true);
    }
  });

  it("gives overlay formats ids, as the upstream schema expects of new entries", () => {
    for (const type of rules.types.filter((t) => t.origin === "overlay")) {
      expect(type.spec.id).toBe(type.id);
    }
  });
});

describe("checksums", () => {
  it("GS1 mod 10 (DHL NVE) accepts a computed check digit and rejects its neighbour", () => {
    const spec = { name: "mod10", evens_multiplier: 3, odds_multiplier: 1 } as const;
    expect(verifyChecksum(spec, "0034043383644263659", "7")).toBe(true);
    expect(verifyChecksum(spec, "0034043383644263659", "8")).toBe(false);
  });

  it("weights 4 and 9 (DHL Paket 12)", () => {
    const spec = { name: "mod10", evens_multiplier: 4, odds_multiplier: 9 } as const;
    expect(verifyChecksum(spec, "20129845227", "7")).toBe(true);
  });

  it("mod 7, S10, Luhn, MOD 37,36 and weighted sums", () => {
    expect(verifyChecksum({ name: "mod7" }, "331881002", "5")).toBe(true);
    expect(verifyChecksum({ name: "s10" }, "12345678", "5")).toBe(true);
    expect(verifyChecksum({ name: "luhn" }, "7992739871", "3")).toBe(true);
    expect(verifyChecksum({ name: "luhn" }, "7992739871", "4")).toBe(false);
    expect(verifyChecksum({ name: "mod_37_36" }, "09980000020033", "F")).toBe(true);
    expect(
      verifyChecksum(
        {
          name: "sum_product_with_weightings_and_modulo",
          weightings: [3, 1, 7, 3, 1, 7, 3, 1, 7, 3, 1],
          modulo1: 11,
          modulo2: 10,
        },
        "98657878885",
        "5",
      ),
    ).toBe(true);
  });
});

describe("detectTrackingNumbers", () => {
  it("finds every valid test number inside prose", () => {
    const missing: string[] = [];
    for (const type of rules.types) {
      for (const number of type.spec.test_numbers.valid) {
        const found = detectTrackingNumbers(rules, `Your parcel ${number.trim()} is on its way.`);
        const expected = matchType(type, number);
        const carrier = expected === null ? "" : carrierOf(rules.carriers, expected);
        const hit = found.some((c) => c.types.includes(type.id) && c.carrier === carrier);
        if (!hit) missing.push(`${type.id}: ${number}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("normalises whitespace and case", () => {
    const [first] = detectTrackingNumbers(rules, "Sendung: 0034 0434 1234 5678 9012", {
      country: "DE",
    });
    expect(first).toMatchObject({
      carrier: "dhl",
      trackingNumber: "00340434123456789012",
      checksumValid: true,
    });
  });

  it("does not report a 14-digit run inside a longer valid number", () => {
    const found = detectTrackingNumbers(rules, "Paketnummer 00340434123456789012");
    expect(found.every((c) => c.trackingNumber === "00340434123456789012")).toBe(true);
  });

  it("returns every carrier for an ambiguous 14-digit number and lets hints decide", () => {
    const text = "Sendungsnummer 09123456789013";
    const plain = detectTrackingNumbers(rules, text).map((c) => c.carrier);
    expect(plain).toEqual(expect.arrayContaining(["hermes", "dpd", "dhl"]));
    const hermes = detectTrackingNumbers(rules, text, { senderDomain: "myhermes.de" });
    expect(hermes[0]?.carrier).toBe("hermes");
    const dpd = detectTrackingNumbers(rules, text, { carrier: "DPD Deutschland" });
    expect(dpd[0]?.carrier).toBe("dpd");
  });

  it("tells 12-digit DHL and GLS numbers apart by their check digits", () => {
    expect(detectTrackingNumbers(rules, "Nr. 123456789016").map((c) => c.carrier)).toContain("dhl");
    expect(detectTrackingNumbers(rules, "Nr. 123456789016").map((c) => c.carrier)).not.toContain(
      "gls",
    );
    expect(detectTrackingNumbers(rules, "Nr. 123456789011").map((c) => c.carrier)).toContain("gls");
  });

  it("maps S10 numbers to the issuing country's postal operator", () => {
    expect(detectTrackingNumbers(rules, "RB123456785GB")[0]).toMatchObject({
      carrier: "royalmail",
    });
    expect(detectTrackingNumbers(rules, "RB123456785DE")[0]).toMatchObject({ carrier: "dhl" });
    expect(detectTrackingNumbers(rules, "RB123456785CV").map((c) => c.carrier)).toContain("upu");
  });

  it("drops a failed check digit unless the caller names the carrier", () => {
    expect(
      detectTrackingNumbers(rules, "1Z5R89390357567128").some((c) => c.carrier === "ups"),
    ).toBe(false);
    const hinted = detectTrackingNumbers(rules, "1Z5R89390357567128", { carrier: "UPS" });
    expect(hinted.find((c) => c.carrier === "ups")).toMatchObject({ checksumValid: false });
  });

  it("ignores ordinary numbers in text", () => {
    expect(detectTrackingNumbers(rules, "Call 12345 or pay 99,95 EUR by 2026-11-20.")).toEqual([]);
  });

  it("keeps confidences within 0..1 and sorted", () => {
    const found = detectTrackingNumbers(
      rules,
      "TBA012345678901 3SABCD1234567 H1000012000000101001",
    );
    const values = found.map((c) => c.confidence);
    expect(values.every((v) => v > 0 && v < 1)).toBe(true);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });
});

describe("detection on hostile text (RU-001)", () => {
  const number = "00340434123456789012";
  const inputs: [string, string][] = [
    ["100k spaces", " ".repeat(100_000)],
    ["mixed Unicode whitespace", "\u2000\u3000\t \v\f\u00a0\ufeff".repeat(12_500)],
    ["digit pairs", "1 ".repeat(50_000)],
    ["14-digit table", "12345678901234 ".repeat(6_000)],
  ];

  it.each(inputs)("scans %s well under a second", (_name, text) => {
    const began = performance.now();
    detectTrackingNumbers(rules, text);
    expect(performance.now() - began).toBeLessThan(1000);
  });

  it("still finds a number after a long whitespace run", () => {
    const found = detectTrackingNumbers(rules, `${" ".repeat(100_000)}Paket ${number}`);
    expect(found.map((c) => c.trackingNumber)).toContain(number);
  });

  it("collapses whitespace runs and cuts overlong lines at a space", () => {
    expect(scanLines("a \u3000\t b\r\nc")).toEqual(["a b", "c"]);
    const pieces = scanLines(`${"x".repeat(MAX_LINE - 1)} ${number}`);
    expect(pieces).toEqual(["x".repeat(MAX_LINE - 1), ` ${number}`]);
  });

  it("strips only the optional whitespace edges of a search pattern", () => {
    expect(withoutEdgeSpaces("\\s*1\\s*Z\\s*")).toBe("1\\s*Z");
    expect(withoutEdgeSpaces("\\s*?1")).toBe("\\s*?1");
    expect(withoutEdgeSpaces("1\\\\s*")).toBe("1\\\\s*");
  });
});
