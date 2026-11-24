import type { IgnoreEntry, StatusEntry, StatusFile, StatusMatch } from "./schema/status.ts";
import { compileDataRegex } from "./portability.ts";
import type { EmailEvent, MappedStatus, RawStatus, ResolvedStatus } from "./types.ts";

/** Entries of one kind (status entries or ignore entries), indexed for matching. */
export interface CompiledMatcher<E> {
  readonly fields: readonly {
    readonly fields: readonly (readonly [string, string])[];
    readonly entry: E;
  }[];
  readonly codes: ReadonlyMap<string, E>;
  readonly foldedCodes: ReadonlyMap<string, E>;
  readonly prefixes: readonly { readonly prefix: string; readonly entry: E }[];
  readonly texts: readonly {
    readonly regex: RegExp;
    /** Raw fields that must also match, when the entry names any. */
    readonly fields: readonly (readonly [string, string])[];
    readonly entry: E;
  }[];
}

type FieldPairs = readonly (readonly [string, string])[];

function fieldPairs(fields: Readonly<Record<string, string>> | undefined): [string, string][] {
  return Object.entries(fields ?? {}).map(([k, v]) => [k, v.trim()]);
}

function fieldsHold(wanted: FieldPairs, given: RawStatus["fields"]): boolean {
  return wanted.every(
    ([name, value]) =>
      given !== undefined && Object.hasOwn(given, name) && given[name]?.trim() === value,
  );
}

export interface CompiledStatusTable extends CompiledMatcher<StatusEntry> {
  readonly carrier: string;
  readonly ignore: CompiledMatcher<IgnoreEntry>;
}

function compileMatcher<E extends { readonly match: StatusMatch }>(
  entries: readonly E[],
): CompiledMatcher<E> {
  const fields: { fields: [string, string][]; entry: E }[] = [];
  const codes = new Map<string, E>();
  const foldedCodes = new Map<string, E>();
  const prefixes: { prefix: string; entry: E }[] = [];
  const texts: { regex: RegExp; fields: FieldPairs; entry: E }[] = [];
  for (const entry of entries) {
    const match = entry.match;
    if ("code" in match) {
      const code = match.code.trim();
      if (!codes.has(code)) codes.set(code, entry);
      if (!foldedCodes.has(code.toUpperCase())) foldedCodes.set(code.toUpperCase(), entry);
    } else if ("code_prefix" in match) {
      prefixes.push({ prefix: match.code_prefix.trim().toUpperCase(), entry });
    } else if ("text" in match) {
      const regex = compileDataRegex(match.text, match.flags);
      texts.push({ regex, fields: fieldPairs(match.fields), entry });
    } else {
      fields.push({ fields: fieldPairs(match.fields), entry });
    }
  }
  return { fields, codes, foldedCodes, prefixes, texts };
}

export function compileStatusTable(file: Omit<StatusFile, "tests">): CompiledStatusTable {
  return {
    carrier: file.carrier,
    ...compileMatcher(file.entries),
    ignore: compileMatcher(file.ignore),
  };
}

/**
 * The first entry for a raw value: field entries, then the exact code (as written, then ignoring
 * case), then code prefixes, then text regexes. Within each kind, file order decides.
 */
function findEntry<E>(matcher: CompiledMatcher<E>, raw: RawStatus): E | undefined {
  if (raw.fields !== undefined) {
    const hit = matcher.fields.find(({ fields }) => fieldsHold(fields, raw.fields));
    if (hit !== undefined) return hit.entry;
  }
  const code = raw.code?.trim();
  if (code !== undefined && code !== "") {
    const folded = code.toUpperCase();
    const entry =
      matcher.codes.get(code) ??
      matcher.foldedCodes.get(folded) ??
      matcher.prefixes.find(({ prefix }) => folded.startsWith(prefix))?.entry;
    if (entry !== undefined) return entry;
  }
  const text = raw.text?.trim();
  if (text !== undefined && text !== "") {
    return matcher.texts.find(
      ({ regex, fields }) => regex.test(text) && fieldsHold(fields, raw.fields),
    )?.entry;
  }
  return undefined;
}

function toMapped(entry: StatusEntry): MappedStatus {
  return {
    status: entry.status,
    ...(entry.pickup === true ? { pickup: true } : {}),
    confirmed: entry.confirmed ?? true,
    ...(entry.stage === undefined ? {} : { stage: entry.stage }),
    ...(entry.label === undefined ? {} : { label: entry.label }),
  };
}

export function mapWithTable(table: CompiledStatusTable, raw: RawStatus): MappedStatus | null {
  const entry = findEntry(table, raw);
  return entry === undefined ? null : toMapped(entry);
}

/** The event an `ignore` entry gives a raw value, or null when none matches. */
export function ignoredWithTable(table: CompiledStatusTable, raw: RawStatus): EmailEvent | null {
  return findEntry(table.ignore, raw)?.event ?? null;
}

function rawLabel(raw: RawStatus): string | null {
  const code = raw.code?.trim();
  if (code !== undefined && code !== "") return code;
  const text = raw.text?.trim();
  if (text !== undefined && text !== "") return text;
  const fields = Object.entries(raw.fields ?? {}).map(([name, value]) => `${name}=${value}`);
  return fields.length === 0 ? null : fields.join(",");
}

/**
 * Maps the latest event; when it is unknown, falls back to the newest history entry that maps.
 * `history` is ordered newest first.
 */
export function resolveWithTable(
  table: CompiledStatusTable | undefined,
  latest: RawStatus,
  history: readonly RawStatus[],
): ResolvedStatus {
  const latestMapped = table === undefined ? null : mapWithTable(table, latest);
  if (latestMapped !== null && latestMapped.status !== "unknown") {
    return { status: latestMapped.status, source: "latest", unmapped: null };
  }
  // A value the table knows to carry no information (mapped to unknown) is not worth a warning.
  const unmapped = latestMapped === null ? rawLabel(latest) : null;
  if (table !== undefined) {
    for (const event of history) {
      const mapped = mapWithTable(table, event);
      // An entry mapped to unknown carries no information either (often the latest repeated).
      if (mapped !== null && mapped.status !== "unknown") {
        return { status: mapped.status, source: "history", unmapped };
      }
    }
  }
  return { status: "unknown", source: "unknown", unmapped };
}
