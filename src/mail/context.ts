/*
 * Guards for tracking numbers found by format detection rather than by a rule's own regex. A
 * number that merely fits a format (an account id, a customer number, a placeholder) must not
 * become a parcel: it has to come from a known sender, sit next to tracking words or inside a
 * tracking link, and survive the carrier's own number pattern.
 */
import { carrierForDomain, domainMatches } from "../carriers.ts";
import type { Rules } from "../rules.ts";
import type { TrackingCandidate } from "../types.ts";

/** Lines above a number that may hold its label ("Sendungsnummer:" on its own line). */
const LINES_BEFORE = 1;
const URL = /https?:\/\/[^\s"<>]+/giu;
/** "Ihre Sendung 0912…", "Your shipment LX…": a parcel noun on the number's own line. */
const PARCEL_NOUN =
  /(?<!\p{L})(?:sendung|paket|shipment|parcel|package|paczk[aię]|przesyłk[aię]|colis|pacco|spedizione|envío|zending|pakket)(?!\p{L})/iu;
const TRACKING_PATH = /track|verfolg|sendung|parcel|paket|shipment|status/iu;

/** Bullet lines that are instructions, not item names. */
const BOILERPLATE_ITEM =
  /^(?:enter|click|tap|sign in|log in|geben sie|klicken sie|tippen sie|melden sie|bitte)\b|postal code|zip code|postleitzahl/iu;

function compact(value: string): string {
  return value.replace(/[\s-]+/gu, "").toUpperCase();
}

/**
 * One character repeated, or a run of 9s and 0s with at most a check digit after it
 * ("990000000000002"). Long zero runs alone are not enough: DHL's 00340434… numbers have them.
 */
export function isPlaceholder(trackingNumber: string): boolean {
  const number = compact(trackingNumber);
  return /^(.)\1+$/u.test(number) || /^[09]+\d?$/u.test(number);
}

/** False when the carrier publishes a number pattern the candidate does not fit. */
export function fitsCarrierPattern(rules: Rules, candidate: TrackingCandidate): boolean {
  const pattern = rules.carriers.byId.get(candidate.carrier)?.trackingNumberPattern;
  return pattern === undefined || pattern.test(compact(candidate.trackingNumber));
}

/** A carrier domain, or a domain some (non-ignore) mail rule reads. */
export function isKnownSender(rules: Rules, domain: string): boolean {
  return (
    carrierForDomain(rules.carriers, domain) !== undefined ||
    rules.mailRules.some(
      (rule) =>
        rule.kind !== "ignore" && rule.domains.some((known) => domainMatches(domain, known)),
    )
  );
}

/**
 * The number is a whole value or path segment of a tracking link (`?piececode=<n>&`,
 * `/track/<n>`), not a piece of a longer token such as a timestamp in `id_202601191820_1`.
 */
function inTrackingUrl(line: string, number: string): boolean {
  return Array.from(line.matchAll(URL), (match) => match[0]).some((url) => {
    if (!TRACKING_PATH.test(url)) return false;
    const link = compact(url);
    let at = link.indexOf(number);
    while (at >= 0) {
      const before = at === 0 ? "" : link.charAt(at - 1);
      const after = link.charAt(at + number.length);
      if (/^[=/:]?$/u.test(before) && /^[&/#?;.]?$/u.test(after)) return true;
      at = link.indexOf(number, at + 1);
    }
    return false;
  });
}

/** The line with every link removed: numbers inside links count only via inTrackingUrl. */
function withoutLinks(line: string): string {
  return line.replace(URL, " ");
}

/** True when the number sits next to a tracking keyword or inside a tracking link. */
export function inTrackingContext(rules: Rules, body: string, trackingNumber: string): boolean {
  const number = compact(trackingNumber);
  const lines = body.split(/\r?\n/u);
  return lines.some((line, index) => {
    if (!compact(line).includes(number)) return false;
    if (inTrackingUrl(line, number)) return true;
    if (!compact(withoutLinks(line)).includes(number)) return false;
    if (PARCEL_NOUN.test(line)) return true;
    const window = lines.slice(Math.max(0, index - LINES_BEFORE), index + 1).join("\n");
    return rules.trackingKeywords.test(window);
  });
}

/** Keeps the detected numbers a mail may turn into parcels. */
export function trustedCandidates(
  rules: Rules,
  body: string,
  candidates: readonly TrackingCandidate[],
): TrackingCandidate[] {
  return candidates.filter(
    (candidate) =>
      !isPlaceholder(candidate.trackingNumber) &&
      fitsCarrierPattern(rules, candidate) &&
      inTrackingContext(rules, body, candidate.trackingNumber),
  );
}

export function isBoilerplateItem(item: string): boolean {
  return BOILERPLATE_ITEM.test(item.trim());
}
