import { parseWithGrammar } from "../arrival/parse.ts";
import { domainMatches, lookupCarrier } from "../carriers.ts";
import type { Rules } from "../rules.ts";
import { grammarFor } from "../rules.ts";
import type { MailField, MailPart } from "../schema/mail.ts";
import { detect } from "../tracking/detect.ts";
import { normalizeTrackingNumber } from "../tracking/validate.ts";
import type { ArrivalWindow, MailInput, MailParseResult } from "../types.ts";
import type { CompiledMailRule, CompiledPattern } from "./compile.ts";
import {
  fitsCarrierPattern,
  isBoilerplateItem,
  isKnownSender,
  isPlaceholder,
  trustedCandidates,
} from "./context.ts";
import { EXTRACTORS } from "./extractors.ts";
import { htmlToText } from "./html.ts";
import { parseMoney } from "./money.ts";
import { extractSchemaOrg } from "./schema-org.ts";

type Parts = Readonly<Record<MailPart, string>>;

interface Prepared {
  readonly address: string;
  readonly domain: string;
  readonly parts: Parts;
  readonly mail: MailInput;
}

/** Confidence a number found by the fallback needs; below it the mail is left alone. */
const FALLBACK_THRESHOLD = 0.6;
const TRAILING_URL_PUNCTUATION = /[.,;:!)\]>]+$/u;

/** The URL when it is http(s); `javascript:`, `data:` and the like are dropped. */
export function httpUrl(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:" ? url : undefined;
}

export function senderAddress(from: string): string {
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/u.exec(from)?.[1];
  const bare = /[^\s<>"]+@[^\s<>"]+/u.exec(from)?.[0];
  return (bracketed ?? bare ?? from).trim().toLowerCase();
}

function prepare(mail: MailInput): Prepared {
  const address = senderAddress(mail.from);
  const html = mail.html === undefined ? "" : htmlToText(mail.html);
  const text = mail.text ?? html;
  return {
    address,
    domain: address.slice(address.lastIndexOf("@") + 1),
    parts: { subject: mail.subject, text, html },
    mail,
  };
}

function senderMatches(rule: CompiledMailRule, prepared: Prepared): boolean {
  if (rule.addresses.has(prepared.address)) return true;
  if (!rule.domains.some((domain) => domainMatches(prepared.domain, domain))) return false;
  const local = prepared.address.slice(0, prepared.address.lastIndexOf("@"));
  return rule.localParts === null || rule.localParts.has(local);
}

function ruleApplies(rule: CompiledMailRule, prepared: Prepared): boolean {
  const { subject, text } = prepared.parts;
  return (
    senderMatches(rule, prepared) &&
    !rule.exclude.some((regex) => regex.test(subject)) &&
    (rule.subject === null || rule.subject.some((regex) => regex.test(subject))) &&
    (rule.body === null || rule.body.some((regex) => regex.test(text)))
  );
}

function anyMatch(patterns: readonly CompiledPattern[], parts: Parts): boolean {
  return patterns.some((pattern) => pattern.in.some((part) => pattern.regex.test(parts[part])));
}

function collectField(rule: CompiledMailRule, field: MailField, parts: Parts): string[] {
  const values = (rule.extract.get(field) ?? []).flatMap((pattern) =>
    pattern.in.flatMap((part) =>
      Array.from(parts[part].matchAll(pattern.regex), (match) => match.groups?.[field]?.trim()),
    ),
  );
  return unique(values.filter((value): value is string => value !== undefined && value !== ""));
}

function arrivalFrom(
  rules: Rules,
  texts: readonly string[],
  mail: MailInput,
): ArrivalWindow | undefined {
  if (mail.date === undefined) return undefined;
  const grammar = grammarFor(rules);
  if (grammar === null) return undefined;
  const { date } = mail;
  const windows = texts
    .map((text) => parseWithGrammar(grammar, text, date, mail.timeZone ?? "UTC"))
    .filter((window) => window !== null);
  // "kommt heute" in the subject and "heute 14-18 Uhr" in the body: the timed one says more.
  return windows.find((window) => !window.allDay) ?? windows[0];
}

/** The carrier the mail names in its carrier field, if the rule reads one. */
function namedCarrier(rules: Rules, rule: CompiledMailRule, parts: Parts): string | undefined {
  if (!rule.carrierFrom) return undefined;
  for (const name of collectField(rule, "carrier", parts)) {
    const carrier = lookupCarrier(rules.carriers, name);
    if (carrier !== undefined) return carrier.id;
  }
  return undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

interface Draft {
  carrier: string | undefined;
  trackingNumbers: string[];
}

function runExtractors(
  rules: Rules,
  rule: CompiledMailRule,
  prepared: Prepared,
  draft: Draft,
): void {
  for (const name of rule.extractors) {
    const extractor = EXTRACTORS[name];
    if (extractor === undefined) continue;
    const output = extractor({
      subject: prepared.parts.subject,
      text: prepared.parts.text,
      senderDomain: prepared.domain,
      carrier: draft.carrier ?? rule.carrier,
      detect: (text, hints) => trustedCandidates(rules, text, detect(rules, text, hints)),
    });
    draft.trackingNumbers = unique([...draft.trackingNumbers, ...(output.trackingNumbers ?? [])]);
    draft.carrier ??= output.carrier;
  }
}

function applyRule(
  rules: Rules,
  rule: CompiledMailRule,
  prepared: Prepared,
): MailParseResult | null {
  const { parts } = prepared;
  const draft: Draft = {
    carrier: namedCarrier(rules, rule, parts),
    trackingNumbers: unique(
      collectField(rule, "tracking_number", parts).map(normalizeTrackingNumber),
    ),
  };
  runExtractors(rules, rule, prepared, draft);
  // Named in the mail, else recognised from the numbers, else the rule's default.
  draft.carrier ??= rule.carrier;
  const orderNumbers = collectField(rule, "order_number", parts);
  // A 14-digit order number also looks like a 14-digit parcel number; the label decides.
  const orders = new Set(orderNumbers.map(normalizeTrackingNumber));
  draft.trackingNumbers = draft.trackingNumbers.filter((number) => !orders.has(number));
  const items = collectField(rule, "item", parts).filter((item) => !isBoilerplateItem(item));
  const trackingUrl = httpUrl(
    collectField(rule, "tracking_url", parts)[0]?.replace(TRAILING_URL_PUNCTUATION, ""),
  );
  const pickupCode = collectField(rule, "pickup_code", parts)[0];
  const total = collectField(rule, "total", parts)
    .map((text) => parseMoney(text, rule.currency))
    .find((money) => money !== undefined);
  const arrival = arrivalFrom(rules, collectField(rule, "arrival", parts), prepared.mail);
  const status =
    rule.statusKeywords.find((group) => anyMatch(group.patterns, parts))?.status ??
    rule.defaultStatus;
  const event = rule.eventKeywords.find((group) => anyMatch(group.patterns, parts))?.event;
  const present: Record<MailField, boolean> = {
    tracking_number: draft.trackingNumbers.length > 0,
    order_number: orderNumbers.length > 0,
    tracking_url: trackingUrl !== undefined,
    pickup_code: pickupCode !== undefined,
    item: items.length > 0,
    arrival: arrival !== undefined,
    carrier: draft.carrier !== undefined,
    total: total !== undefined,
  };
  if (!rule.require.every((field) => present[field])) return null;
  const anything =
    Object.values(present).some(Boolean) || status !== undefined || event !== undefined;
  if (!anything) return null;
  return {
    ruleId: rule.id,
    kind: rule.kind,
    trackingNumbers: draft.trackingNumbers,
    orderNumbers,
    ...(draft.carrier === undefined ? {} : { carrier: draft.carrier }),
    ...(status === undefined ? {} : { status }),
    ...(event === undefined ? {} : { event }),
    ...(arrival === undefined ? {} : { arrival }),
    ...(items.length === 0 ? {} : { items }),
    ...(trackingUrl === undefined ? {} : { trackingUrl }),
    ...(pickupCode === undefined ? {} : { pickupCode }),
    ...(total === undefined ? {} : { total }),
  };
}

/** Whether a schema.org number may become a parcel: no placeholder, and the carrier's shape. */
function plausibleNumber(rules: Rules, number: string, carrier: string | undefined): boolean {
  if (isPlaceholder(number)) return false;
  if (carrier === undefined) return true;
  const candidate = {
    carrier,
    trackingNumber: number,
    confidence: 1,
    checksumValid: null,
    types: [],
  };
  return fitsCarrierPattern(rules, candidate);
}

function schemaOrgResults(rules: Rules, prepared: Prepared): MailParseResult[] {
  // Like the fallback, only carriers and shops the rules know may announce a parcel by markup.
  if (!isKnownSender(rules, prepared.domain)) return [];
  return extractSchemaOrg(prepared.mail.html).map((delivery) => {
    const carrier =
      delivery.carrierName === undefined
        ? undefined
        : lookupCarrier(rules.carriers, delivery.carrierName)?.id;
    const trackingUrl = httpUrl(delivery.trackingUrl);
    const arrival =
      delivery.expectedUntil === undefined
        ? undefined
        : arrivalFromIso(delivery.expectedFrom, delivery.expectedUntil);
    return {
      ruleId: "schema.org",
      kind: "parcel" as const,
      trackingNumbers: delivery.trackingNumbers
        .map(normalizeTrackingNumber)
        .filter((number) => plausibleNumber(rules, number, carrier)),
      orderNumbers: delivery.orderNumbers,
      ...(carrier === undefined ? {} : { carrier }),
      ...(delivery.status === undefined ? {} : { status: delivery.status }),
      ...(arrival === undefined ? {} : { arrival }),
      ...(delivery.items.length === 0 ? {} : { items: delivery.items }),
      ...(trackingUrl === undefined ? {} : { trackingUrl }),
    };
  });
}

function arrivalFromIso(from: string | undefined, until: string): ArrivalWindow | undefined {
  if (Number.isNaN(Date.parse(until))) return undefined;
  const start = from !== undefined && !Number.isNaN(Date.parse(from)) ? from : until;
  return { from: start, to: until, allDay: false, matched: `${start}/${until}` };
}

function fallback(rules: Rules, prepared: Prepared): MailParseResult[] {
  const { subject, text } = prepared.parts;
  const body = `${subject}\n${text}`;
  // Only carriers and shops the rules know may announce a parcel by a bare number.
  if (!isKnownSender(rules, prepared.domain)) return [];
  const candidates = trustedCandidates(
    rules,
    body,
    detect(rules, body, { senderDomain: prepared.domain }),
  ).filter((candidate) => candidate.confidence >= FALLBACK_THRESHOLD);
  if (candidates.length === 0) return [];
  const carriers = new Set(candidates.map((candidate) => candidate.carrier));
  const [only] = carriers;
  return [
    {
      ruleId: "fallback",
      kind: "parcel",
      trackingNumbers: unique(candidates.map((candidate) => candidate.trackingNumber)),
      orderNumbers: [],
      ...(carriers.size === 1 && only !== undefined ? { carrier: only } : {}),
    },
  ];
}

/** True when an `ignore` rule matches the mail's sender, subject and (if given) text. */
export function isIgnoredMail(rules: Rules, mail: MailInput): boolean {
  const prepared = prepare(mail);
  return rules.mailRules.some((rule) => rule.kind === "ignore" && ruleApplies(rule, prepared));
}

export function parseMailWith(rules: Rules, mail: MailInput): MailParseResult[] {
  const prepared = prepare(mail);
  const applying = rules.mailRules.filter((rule) => ruleApplies(rule, prepared));
  // Account, developer-portal and newsletter mails never describe a parcel.
  if (applying.some((rule) => rule.kind === "ignore")) return [];
  const results: MailParseResult[] = [];
  for (const rule of applying) {
    const result = applyRule(rules, rule, prepared);
    if (result !== null) results.push(result);
  }
  results.push(...schemaOrgResults(rules, prepared));
  return results.length > 0 ? results : fallback(rules, prepared);
}
