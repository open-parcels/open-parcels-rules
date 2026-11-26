import { parseWithGrammar } from "./arrival/parse.ts";
import { buildTrackingUrl, lookupCarrier } from "./carriers.ts";
import { fitsCarrierPattern, isBoilerplateItem, isPlaceholder } from "./mail/context.ts";
import { isIgnoredEmail, parseEmailWith } from "./mail/parse.ts";
import type { Rules } from "./rules.ts";
import { grammarFor, keyId } from "./rules.ts";
import { ignoredWithTable, mapWithTable, resolveWithTable } from "./status.ts";
import { detect } from "./tracking/detect.ts";
import type {
  ArrivalOptions,
  ArrivalWindow,
  CarrierInfo,
  CarrierKey,
  DetectHints,
  EmailEvent,
  EmailInput,
  EmailParseResult,
  MappedStatus,
  RawStatus,
  ResolvedStatus,
  TrackingCandidate,
} from "./types.ts";

export { loadRules } from "./load.ts";
export { rulesFromBundle, withEmailRules } from "./rules.ts";
/** An email rule as a provider ships it: the format of `schema/mail-rule.schema.json`. */
export type { MailRuleInput as EmailRuleDefinition } from "./schema/mail.ts";
export { portabilityProblems } from "./portability.ts";
export { PARCEL_STATUSES } from "./schema/common.ts";
export { parseMoney } from "./mail/money.ts";
export type { Rules } from "./rules.ts";
export type * from "./types.ts";

/** Every carrier in the registry. */
export function carriers(rules: Rules): CarrierInfo[] {
  return [...rules.carriers.list];
}

/** A carrier by id, name or alias; case, accents and punctuation are ignored. */
export function findCarrier(rules: Rules, nameOrAlias: string): CarrierInfo | undefined {
  return lookupCarrier(rules.carriers, nameOrAlias);
}

/**
 * The carrier's tracking page for a number, in the locale's language (or regional site) where
 * one is listed. `params` fills a template's other placeholders, such as `{postcode}`; a
 * template whose placeholders are not all given is skipped for the next, less specific one.
 */
export function trackingUrl(
  rules: Rules,
  carrierId: string,
  trackingNumber: string,
  locale?: string,
  params?: Readonly<Record<string, string>>,
): string | undefined {
  const carrier = lookupCarrier(rules.carriers, carrierId);
  return carrier === undefined
    ? undefined
    : buildTrackingUrl(carrier, trackingNumber, locale, params);
}

/**
 * Tracking numbers in free text, every plausible carrier per number, best first. Hints raise
 * the confidence of matching carriers and lower the others'.
 */
export function detectTrackingNumbers(
  rules: Rules,
  text: string,
  hints?: DetectHints,
): TrackingCandidate[] {
  return detect(rules, text, hints);
}

/** A carrier's raw status code or text as a canonical status; null when the table lacks it. */
export function mapStatus(rules: Rules, carrier: string, raw: RawStatus): MappedStatus | null {
  const id = lookupCarrier(rules.carriers, carrier)?.id ?? carrier;
  const table = rules.statusTables.get(id);
  return table === undefined ? null : mapWithTable(table, raw);
}

/**
 * The event an `ignore` entry of the carrier's table gives a raw value (an order line that was
 * cancelled, refunded or returned is no parcel), or null when none matches.
 */
export function ignoredStatus(rules: Rules, carrier: string, raw: RawStatus): EmailEvent | null {
  const id = lookupCarrier(rules.carriers, carrier)?.id ?? carrier;
  const table = rules.statusTables.get(id);
  return table === undefined ? null : ignoredWithTable(table, raw);
}

/**
 * The day offset (0 today, -1 yesterday) a word names on its own, from the locales' `past_days`
 * (all loaded locales unless `locales` names some), or undefined. The word is compared in lower
 * case.
 */
export function pastDayOffset(
  rules: Rules,
  word: string,
  locales?: readonly string[],
): number | undefined {
  const wanted = word.trim().toLowerCase();
  const ids = locales?.map((id) => id.toLowerCase().split(/[-_]/u)[0] ?? id) ?? [
    ...rules.locales.keys(),
  ];
  for (const id of ids) {
    const offset = rules.locales.get(id)?.past_days[wanted];
    if (offset !== undefined) return offset;
  }
  return undefined;
}

/**
 * The status of a parcel: the latest event if it maps, else the newest mapping history entry
 * (history is ordered newest first), else unknown. `unmapped` names the latest raw value when
 * it did not map, so callers can warn about it once.
 */
export function resolveStatus(
  rules: Rules,
  carrier: string,
  latest: RawStatus,
  history: readonly RawStatus[],
): ResolvedStatus {
  const id = lookupCarrier(rules.carriers, carrier)?.id ?? carrier;
  return resolveWithTable(rules.statusTables.get(id), latest, history);
}

/**
 * A fixed public value a carrier expects from every client (a website or app key, client id,
 * app version or User-Agent), by carrier id or name and key name; undefined when not listed.
 */
export function findCarrierKey(
  rules: Rules,
  carrier: string,
  name: string,
): CarrierKey | undefined {
  const id = lookupCarrier(rules.carriers, carrier)?.id ?? carrier;
  return rules.keys.get(keyId(id, name));
}

/** Every fixed public key listed for a carrier. */
export function carrierKeys(rules: Rules, carrier: string): CarrierKey[] {
  const id = lookupCarrier(rules.carriers, carrier)?.id ?? carrier;
  return [...rules.keys.values()].filter((key) => key.carrier === id);
}

/** A delivery date or window in text such as "Arriving 3 - 5 December" or "heute 17h - 19h". */
export function parseArrival(
  rules: Rules,
  text: string,
  options: ArrivalOptions,
): ArrivalWindow | null {
  const grammar = grammarFor(rules, options.locales);
  return grammar === null ? null : parseWithGrammar(grammar, text, options.now, options.timeZone);
}

/**
 * Whether a number a mail named could still stand for a parcel under the current mail rules:
 * not a placeholder (runs of 0 or 9, one digit repeated) and fitting the carrier's number
 * pattern where carriers.yaml lists one. For re-checking parcels that mails created earlier.
 */
export function plausibleEmailTrackingNumber(
  rules: Rules,
  carrier: string,
  trackingNumber: string,
): boolean {
  const id = lookupCarrier(rules.carriers, carrier)?.id ?? carrier;
  return (
    !isPlaceholder(trackingNumber) &&
    fitsCarrierPattern(rules, {
      carrier: id,
      trackingNumber,
      confidence: 1,
      checksumValid: null,
      types: [],
    })
  );
}

/** True for an item bullet that is an instruction ("Enter the recipient's postal code …"). */
export function isBoilerplateItemTitle(title: string): boolean {
  return isBoilerplateItem(title);
}

/** True when an `ignore` mail rule drops a mail with this sender and subject. */
export function ignoredEmail(rules: Rules, from: string, subject: string): boolean {
  return isIgnoredEmail(rules, { from, subject });
}

/** Every rule result for a mail; a format-detection fallback when no rule applies. */
export function parseEmail(rules: Rules, mail: EmailInput): EmailParseResult[] {
  return parseEmailWith(rules, mail);
}
