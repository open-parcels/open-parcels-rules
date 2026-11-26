import type { Grammar, LocaleTable } from "./arrival/grammar.ts";
import { compileGrammar } from "./arrival/grammar.ts";
import type { CarrierIndex } from "./carriers.ts";
import { buildCarrierIndex } from "./carriers.ts";
import type { CompiledMailRule } from "./mail/compile.ts";
import { compileMailRule } from "./mail/compile.ts";
import type { Bundle } from "./schema/bundle.ts";
import { bundleSchema } from "./schema/bundle.ts";
import { mailRuleSchema } from "./schema/mail.ts";
import type { CompiledStatusTable } from "./status.ts";
import type { CarrierKey } from "./types.ts";
import { compileStatusTable } from "./status.ts";
import type { CompiledTrackingType } from "./tracking/compile.ts";
import { compileTrackingTypes } from "./tracking/compile.ts";

/** Loaded, validated and compiled rule data. Build it once and share it; it is read-only. */
export interface Rules {
  readonly version: string;
  readonly carriers: CarrierIndex;
  readonly types: readonly CompiledTrackingType[];
  readonly statusTables: ReadonlyMap<string, CompiledStatusTable>;
  readonly locales: ReadonlyMap<string, LocaleTable>;
  readonly mailRules: readonly CompiledMailRule[];
  /** Merged locale grammars, keyed by the sorted locale list. */
  readonly grammarCache: Map<string, Grammar>;
  readonly trackingKeywords: RegExp;
  /** Fixed public carrier keys, keyed "carrier/name". */
  readonly keys: ReadonlyMap<string, CarrierKey>;
}

export function keyId(carrier: string, name: string): string {
  return `${carrier}/${name}`;
}

function keywordRegex(locales: readonly LocaleTable[]): RegExp {
  const words = locales
    .flatMap((locale) => locale.tracking_keywords)
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&"));
  return words.length === 0
    ? /(?!)/u
    : new RegExp(`(?<![\\p{L}])(?:${words.join("|")})(?![\\p{L}])`, "iu");
}

export function compileBundle(bundle: Bundle): Rules {
  return {
    version: bundle.version,
    carriers: buildCarrierIndex(bundle.carriers),
    types: compileTrackingTypes(bundle.tracking),
    statusTables: new Map(bundle.status.map((file) => [file.carrier, compileStatusTable(file)])),
    locales: new Map(bundle.locales.map((locale) => [locale.lang, locale])),
    mailRules: bundle.mail.map(compileMailRule),
    grammarCache: new Map(),
    trackingKeywords: keywordRegex(bundle.locales),
    keys: new Map(
      bundle.keys.map((key) => [
        keyId(key.carrier, key.name),
        {
          carrier: key.carrier,
          name: key.name,
          purpose: key.purpose,
          source: key.source,
          lastVerified: key.last_verified,
          value: key.value,
        },
      ]),
    ),
  };
}

/**
 * These rules with a provider's own email rules in place of the shared ones, for reading an email
 * that was routed to that provider. The shared `ignore` rules stay (account and newsletter emails
 * never describe a parcel, whoever reads them); every other shared email rule is left out, so the
 * email is read by the provider's rules alone. Carriers, formats, status tables and locales are
 * shared, so schema.org markup and the format-detection fallback read it as they always did.
 * Each definition is validated against the email rule schema; an invalid one throws.
 */
export function withEmailRules(rules: Rules, definitions: readonly unknown[]): Rules {
  const own = definitions.map((definition, index) => {
    const parsed = mailRuleSchema.safeParse(definition);
    if (!parsed.success) {
      throw new Error(
        `Email rule ${String(index)} does not match its schema:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
    return compileMailRule(parsed.data);
  });
  const ids = own.map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) throw new Error("Email rule ids must be unique.");
  return {
    ...rules,
    // In id order, as the bundle lists the shared rules (by file name, which is the id).
    mailRules: [
      ...rules.mailRules.filter((rule) => rule.kind === "ignore"),
      ...own.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ],
  };
}

/** Validates raw bundle data (e.g. parsed dist/bundle.json) and compiles it. */
export function rulesFromBundle(data: unknown): Rules {
  return compileBundle(bundleSchema.parse(data));
}

export function grammarFor(rules: Rules, locales?: readonly string[]): Grammar | null {
  const ids = (locales ?? [...rules.locales.keys()])
    .map((id) => id.toLowerCase().split(/[-_]/u)[0] ?? id)
    .filter((id) => rules.locales.has(id));
  const key = [...new Set(ids)].sort().join(",");
  if (key === "") return null;
  let grammar = rules.grammarCache.get(key);
  if (grammar === undefined) {
    const tables = key.split(",").flatMap((id) => {
      const table = rules.locales.get(id);
      return table === undefined ? [] : [table];
    });
    grammar = compileGrammar(tables);
    rules.grammarCache.set(key, grammar);
  }
  return grammar;
}
