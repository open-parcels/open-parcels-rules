import type { CarrierIndex } from "../carriers.ts";
import { carrierForDomain, lookupCarrier } from "../carriers.ts";
import type { DetectHints, TrackingCandidate } from "../types.ts";
import type { CompiledTrackingType } from "./compile.ts";
import type { TypeMatch } from "./validate.ts";
import { matchType } from "./validate.ts";

interface Hit {
  readonly match: TypeMatch;
  readonly carrier: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

interface Context {
  readonly carriers: CarrierIndex;
  readonly types: readonly CompiledTrackingType[];
}

const UPU = "upu";

/** The carrier a matched format belongs to; S10 numbers go to the issuing country's operator. */
export function carrierOf(carriers: CarrierIndex, match: TypeMatch): string {
  const code = match.type.courierCode;
  if (code === "s10") {
    const country = match.groups["CountryCode"];
    return (country === undefined ? undefined : carriers.byUpuCountry.get(country)) ?? UPU;
  }
  return carriers.byCourierCode.get(code) ?? code;
}

function scanLine(context: Context, line: string, lineIndex: number): Hit[] {
  const hits: Hit[] = [];
  for (const type of context.types) {
    type.search.lastIndex = 0;
    for (let found = type.search.exec(line); found !== null; found = type.search.exec(line)) {
      if (found[0].length === 0) {
        type.search.lastIndex += 1;
        continue;
      }
      const match = matchType(type, found[0]);
      if (match === null) continue;
      const leading = found[0].length - found[0].trimStart().length;
      const start = found.index + leading;
      const end = found.index + found[0].trimEnd().length;
      hits.push({
        match,
        carrier: carrierOf(context.carriers, match),
        line: lineIndex,
        start,
        end,
      });
    }
  }
  return hits;
}

function containedInLine(line: readonly Hit[], dropped: Set<Hit>): void {
  const sorted = [...line].sort((a, b) => a.start - b.start);
  // Furthest end of a valid hit starting strictly before the current start.
  let endBefore = -1;
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index]?.start;
    const group: Hit[] = [];
    for (let hit = sorted[index]; hit !== undefined && hit.start === start; hit = sorted[index]) {
      group.push(hit);
      index += 1;
    }
    const endHere = Math.max(-1, ...group.filter((h) => h.match.valid).map((h) => h.end));
    for (const hit of group) {
      if (endBefore >= hit.end || endHere > hit.end) dropped.add(hit);
    }
    endBefore = Math.max(endBefore, endHere);
  }
}

/**
 * Drops hits lying strictly inside a longer valid hit on the same line (a 14-digit run inside a
 * 20-digit one). Sorted by start and swept per line, so long tables of numbers stay cheap.
 */
function dropContained(hits: readonly Hit[]): Hit[] {
  const byLine = new Map<number, Hit[]>();
  for (const hit of hits) {
    const line = byLine.get(hit.line);
    if (line === undefined) byLine.set(hit.line, [hit]);
    else line.push(hit);
  }
  const dropped = new Set<Hit>();
  for (const line of byLine.values()) containedInLine(line, dropped);
  return hits.filter((hit) => !dropped.has(hit));
}

interface Scored {
  carrier: string;
  trackingNumber: string;
  confidence: number;
  checksumValid: boolean | null;
  types: string[];
  order: number;
}

function hintAdjustment(context: Context, carrier: string, hints: DetectHints): number {
  let delta = 0;
  if (hints.carrier !== undefined) {
    const hinted = lookupCarrier(context.carriers, hints.carrier)?.id;
    if (hinted === carrier) delta += 0.3;
    else if (hinted !== undefined) delta -= 0.15;
  }
  if (hints.senderDomain !== undefined) {
    const sender = carrierForDomain(context.carriers, hints.senderDomain)?.id;
    if (sender === carrier) delta += 0.25;
    else if (sender !== undefined) delta -= 0.1;
  }
  const countries = context.carriers.byId.get(carrier)?.countries ?? [];
  if (hints.country !== undefined && countries.length > 0) {
    delta += countries.includes(hints.country.toUpperCase()) ? 0.05 : -0.1;
  }
  return delta;
}

function mergeHits(context: Context, hits: readonly Hit[], hints: DetectHints): Scored[] {
  const hintedCarrier =
    hints.carrier === undefined ? undefined : lookupCarrier(context.carriers, hints.carrier)?.id;
  const merged = new Map<string, Scored>();
  hits.forEach((hit, order) => {
    const { match } = hit;
    // A failed check digit only survives when the caller says it is this carrier's number.
    if (!match.valid && !(match.checksumValid === false && hintedCarrier === hit.carrier)) return;
    const base = match.valid ? match.type.baseConfidence : 0.05;
    const key = `${hit.carrier}\u0000${match.trackingNumber}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        carrier: hit.carrier,
        trackingNumber: match.trackingNumber,
        confidence: base,
        checksumValid: match.checksumValid,
        types: [match.type.id],
        order,
      });
      return;
    }
    existing.confidence = Math.max(existing.confidence, base);
    if (existing.checksumValid !== true) existing.checksumValid = match.checksumValid;
    if (!existing.types.includes(match.type.id)) existing.types.push(match.type.id);
  });
  return [...merged.values()];
}

function finalScores(context: Context, scored: Scored[], hints: DetectHints): TrackingCandidate[] {
  const carriersPerNumber = new Map<string, number>();
  for (const entry of scored) {
    carriersPerNumber.set(
      entry.trackingNumber,
      (carriersPerNumber.get(entry.trackingNumber) ?? 0) + 1,
    );
  }
  return scored
    .map((entry) => {
      const rivals = (carriersPerNumber.get(entry.trackingNumber) ?? 1) - 1;
      const raw = entry.confidence * 0.8 ** rivals + hintAdjustment(context, entry.carrier, hints);
      return {
        ...entry,
        confidence: Math.round(Math.min(0.99, Math.max(0.01, raw)) * 1000) / 1000,
      };
    })
    .sort((a, b) => b.confidence - a.confidence || a.order - b.order)
    .map(({ carrier, trackingNumber, confidence, checksumValid, types }) => ({
      carrier,
      trackingNumber,
      confidence,
      checksumValid,
      types,
    }));
}

/** Longest line scanned in one piece; longer ones are cut at a space before this length. */
export const MAX_LINE = 4096;

/**
 * The lines detection scans: whitespace runs collapsed to one space (the formats tolerate any
 * amount of it, and long runs made the scan super-linear) and overlong lines cut into pieces.
 * The Python loader splits text the same way.
 */
export function scanLines(text: string): string[] {
  return text.split(/\r?\n/u).flatMap((raw) => {
    let line = raw.replace(/\s+/gu, " ");
    const pieces: string[] = [];
    while (line.length > MAX_LINE) {
      const space = line.lastIndexOf(" ", MAX_LINE);
      const cut = space > 0 ? space : MAX_LINE;
      pieces.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    pieces.push(line);
    return pieces;
  });
}

export function detect(
  context: Context,
  text: string,
  hints: DetectHints = {},
): TrackingCandidate[] {
  const hits = scanLines(text).flatMap((line, index) => scanLine(context, line, index));
  return finalScores(context, mergeHits(context, dropContained(hits), hints), hints);
}

/** Validates one isolated number against every format; all fitting matches, valid or not. */
export function matchAll(context: Context, raw: string): TypeMatch[] {
  return context.types.flatMap((type) => {
    const match = matchType(type, raw);
    return match === null ? [] : [match];
  });
}
