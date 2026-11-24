import { compileDataRegex } from "../portability.ts";
import type { RegexFlag, RegexLike } from "../schema/common.ts";
import { toRegexSpec } from "../schema/common.ts";
import type { MailEvent, MailField, MailKind, MailRule, MailPart } from "../schema/mail.ts";
import type { ParcelStatus } from "../types.ts";

export interface CompiledPattern {
  readonly regex: RegExp;
  readonly in: readonly MailPart[];
}

export interface CompiledMailRule {
  readonly id: string;
  readonly name: string;
  readonly kind: MailKind;
  readonly addresses: ReadonlySet<string>;
  readonly domains: readonly string[];
  /** Lower-cased local parts a domain match must also have; null for any. */
  readonly localParts: ReadonlySet<string> | null;
  readonly subject: readonly RegExp[] | null;
  readonly exclude: readonly RegExp[];
  readonly body: readonly RegExp[] | null;
  readonly extract: ReadonlyMap<MailField, readonly CompiledPattern[]>;
  readonly statusKeywords: readonly { status: ParcelStatus; patterns: CompiledPattern[] }[];
  readonly eventKeywords: readonly { event: MailEvent; patterns: CompiledPattern[] }[];
  readonly defaultStatus: ParcelStatus | undefined;
  readonly carrier: string | undefined;
  readonly carrierFrom: boolean;
  readonly extractors: readonly string[];
  readonly require: readonly MailField[];
}

function compileAll(list: readonly RegexLike[], flags: readonly RegexFlag[]): RegExp[] {
  return list.map((value) => {
    const spec = toRegexSpec(value, flags);
    return compileDataRegex(spec.pattern, spec.flags);
  });
}

function keywordPatterns(
  group: { patterns: RegexLike[]; in: MailPart[] },
  flags: readonly RegexFlag[],
): CompiledPattern[] {
  return compileAll(group.patterns, flags).map((regex) => ({ regex, in: group.in }));
}

export function compileMailRule(rule: Omit<MailRule, "tests">): CompiledMailRule {
  const extract = new Map<MailField, CompiledPattern[]>();
  for (const [field, specs] of Object.entries(rule.extract) as [
    MailField,
    MailRule["extract"][MailField],
  ][]) {
    extract.set(
      field,
      (specs ?? []).map((spec) => ({
        // Every match of a field is collected, so the extraction regexes are global.
        regex: compileDataRegex(spec.pattern, [...(spec.flags ?? rule.flags), "g"]),
        in: spec.in,
      })),
    );
  }
  return {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    addresses: new Set(rule.senders.addresses),
    domains: rule.senders.domains,
    localParts:
      rule.senders.local_parts === undefined
        ? null
        : new Set(rule.senders.local_parts.map((part) => part.toLowerCase())),
    subject: rule.subject === undefined ? null : compileAll(rule.subject, rule.flags),
    exclude: compileAll(rule.exclude ?? [], rule.flags),
    body: rule.body === undefined ? null : compileAll(rule.body, rule.flags),
    extract,
    statusKeywords: rule.status_keywords.map((group) => ({
      status: group.status,
      patterns: keywordPatterns(group, rule.flags),
    })),
    eventKeywords: rule.event_keywords.map((group) => ({
      event: group.event,
      patterns: keywordPatterns(group, rule.flags),
    })),
    defaultStatus: rule.default_status,
    carrier: rule.carrier,
    carrierFrom: rule.carrier_from !== undefined,
    extractors: rule.extractors,
    require: rule.require,
  };
}
