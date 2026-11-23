import type { TrackingSource } from "../schema/bundle.ts";
import type { TrackingNumberType } from "../schema/tracking.ts";
import { checksumStrength } from "./checksums.ts";

export interface CompiledLookup {
  readonly name: string;
  readonly group: string;
  readonly rows: readonly {
    readonly test: (value: string) => boolean;
    readonly row: Readonly<Record<string, string | null>>;
  }[];
}

export interface CompiledTrackingType {
  /** courier_code of the file the format came from. */
  readonly courierCode: string;
  readonly id: string;
  readonly name: string;
  readonly origin: "vendor" | "overlay";
  readonly spec: TrackingNumberType;
  /** Anchored, for validating one number. */
  readonly exact: RegExp;
  /** Unanchored and bounded by non-alphanumerics, for scanning text. */
  readonly search: RegExp;
  readonly prependIf: { readonly test: RegExp; readonly content: string } | null;
  readonly lookups: readonly CompiledLookup[];
  /** How telling a match is before hints (0..1). */
  readonly baseConfidence: number;
}

function joinedRegex(spec: TrackingNumberType): string {
  return Array.isArray(spec.regex) ? spec.regex.join("") : spec.regex;
}

/**
 * The pattern without leading and trailing `\s*`: optional edges change no match, and a leading
 * `\s*` after the look-behind backtracked through every whitespace run (quadratic). The Python
 * loader strips the same edges.
 */
export function withoutEdgeSpaces(pattern: string): string {
  let result = pattern;
  while (result.startsWith("\\s*") && !/^[?+{]/u.test(result.slice(3))) result = result.slice(3);
  while (result.endsWith("\\s*") && !result.endsWith("\\\\s*")) result = result.slice(0, -3);
  return result;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_|_$/gu, "");
}

/** Counts characters the pattern requires literally (a fixed prefix such as "1Z" or "JJD"). */
function literalCount(pattern: string): number {
  const stripped = pattern
    .replace(/\\s\*/gu, "")
    .replace(/\(\?<[A-Za-z]+>/gu, "(")
    .replace(/\\./gu, "")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/\{[^}]*\}/gu, "");
  return (stripped.match(/[A-Za-z0-9]/gu) ?? []).length;
}

function compileLookups(spec: TrackingNumberType): CompiledLookup[] {
  return (spec.additional ?? []).map((additional) => ({
    name: additional.name,
    group: additional.regex_group_name,
    rows: additional.lookup.map((row) => {
      const exact = row["matches"];
      const regex = row["matches_regex"];
      const anchored =
        regex === undefined || regex === null ? null : new RegExp(`^(?:${regex})$`, "u");
      return {
        row,
        test: (value: string) => value === exact || (anchored?.test(value) ?? false),
      };
    }),
  }));
}

function baseConfidence(spec: TrackingNumberType, pattern: string): number {
  const literals = Math.min(literalCount(pattern), 8) * 0.025;
  return Math.min(0.9, 0.35 + checksumStrength(spec.validation.checksum) + literals);
}

export function compileTrackingTypes(sources: readonly TrackingSource[]): CompiledTrackingType[] {
  return sources.flatMap((source) =>
    source.courier.tracking_numbers.map((spec) => {
      const pattern = joinedRegex(spec);
      const prepend = spec.validation.serial_number_format?.prepend_if;
      return {
        courierCode: source.courier.courier_code,
        id: spec.id ?? `${source.courier.courier_code}_${slug(spec.name)}`,
        name: spec.name,
        origin: source.origin,
        spec,
        exact: new RegExp(`^(?:${pattern})$`, "u"),
        search: new RegExp(
          `(?<![A-Za-z0-9])(?:${withoutEdgeSpaces(pattern)})(?![A-Za-z0-9])`,
          "gu",
        ),
        prependIf:
          prepend === undefined
            ? null
            : { test: new RegExp(prepend.matches_regex, "u"), content: prepend.content },
        lookups: compileLookups(spec),
        baseConfidence: baseConfidence(spec, pattern),
      };
    }),
  );
}
