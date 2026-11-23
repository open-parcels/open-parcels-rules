import { z } from "zod";

/** The canonical parcel states every carrier status is mapped onto. Closed set: do not extend. */
export const PARCEL_STATUSES = [
  "registered",
  "in_transit",
  "out_for_delivery",
  "at_pickup_point",
  "delivered",
  "returning",
  "problem",
  "unknown",
] as const;

export const parcelStatusSchema = z.enum(PARCEL_STATUSES).meta({
  description:
    "Canonical parcel status. at_pickup_point means arrived and waiting for collection; " +
    "a parcel still on its way to a pickup point is in_transit with pickup: true.",
});

/** Flags a data regex may carry; ports give each the meaning it has in JavaScript. */
export const REGEX_FLAGS = ["i", "m", "s"] as const;
export const regexFlagSchema = z.enum(REGEX_FLAGS);

export const regexSpecSchema = z
  .strictObject({
    pattern: z.string().min(1).meta({ description: "A regex in the portable subset." }),
    flags: z.array(regexFlagSchema).optional(),
  })
  .meta({
    description:
      "A regex in the portable subset (no lookaround, backreferences, atomic groups, " +
      "possessive quantifiers, \\A/\\Z or inline flags; named groups as (?<name>...)).",
  });

/** A pattern given either as a bare string (no flags) or as an object with flags. */
export const regexLikeSchema = z.union([z.string().min(1), regexSpecSchema]);

export type RegexSpec = z.infer<typeof regexSpecSchema>;
export type RegexLike = z.infer<typeof regexLikeSchema>;
export type RegexFlag = z.infer<typeof regexFlagSchema>;

export function toRegexSpec(value: RegexLike, defaultFlags: readonly RegexFlag[] = []): RegexSpec {
  return typeof value === "string" ? { pattern: value, flags: [...defaultFlags] } : value;
}

export const identifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/u)
  .meta({ description: "Lower-case identifier: letters, digits, '_' and '-'." });
