import { z } from "zod";
import { identifierSchema, parcelStatusSchema, regexFlagSchema, regexLikeSchema } from "./common.ts";

/** `ignore` rules produce nothing: a mail they match yields no result at all. */
export const MAIL_KINDS = ["parcel", "order", "return", "dunning", "ignore"] as const;
export const mailKindSchema = z.enum(MAIL_KINDS);

/** Kind-specific events for mails that are not about a parcel's journey. */
export const MAIL_EVENTS = [
  "order_placed",
  "order_confirmed",
  "order_shipped",
  "order_delivered",
  "order_cancelled",
  "return_started",
  "return_received",
  "refund_issued",
  "return_rejected",
  "payment_reminder",
  "payment_warning",
  "debt_collection",
] as const;
export const mailEventSchema = z.enum(MAIL_EVENTS);

export const MAIL_PARTS = ["subject", "text", "html"] as const;
const mailPartSchema = z.enum(MAIL_PARTS);

export const MAIL_FIELDS = [
  "tracking_number",
  "order_number",
  "tracking_url",
  "pickup_code",
  "item",
  "arrival",
  "carrier",
  "total",
] as const;
export const mailFieldSchema = z.enum(MAIL_FIELDS);

const extractSpecSchema = z.strictObject({
  pattern: z.string().min(1).meta({
    description: "Must contain a named group called like the field, e.g. (?<tracking_number>...).",
  }),
  flags: z.array(regexFlagSchema).optional(),
  in: z.array(mailPartSchema).min(1).default(["subject", "text"]).meta({
    description: "Where to search; html means the HTML part converted to plain text.",
  }),
});

const keywordSchema = z.strictObject({
  patterns: z.array(regexLikeSchema).min(1),
  in: z.array(mailPartSchema).min(1).default(["subject", "text"]),
});

const statusKeywordSchema = keywordSchema.extend({ status: parcelStatusSchema });
const eventKeywordSchema = keywordSchema.extend({ event: mailEventSchema });

const sendersSchema = z
  .strictObject({
    addresses: z.array(z.string().regex(/^[^@\s]+@[a-z0-9.-]+$/u)).default([]),
    domains: z.array(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/u)).default([]).meta({
      description: "Sender domains; subdomains match too.",
    }),
    local_parts: z.array(z.string().regex(/^[^@\s]+$/u)).optional().meta({
      description:
        "If set, a sender matched by `domains` must also have one of these local parts " +
        "(e.g. shipment-tracking for shipment-tracking@amazon.de). Compared case-insensitively.",
    }),
  })
  .refine((senders) => senders.addresses.length + senders.domains.length > 0, {
    message: "A rule needs at least one sender address or domain.",
  });

const mailTestSchema = z.strictObject({
  fixture: z.string().regex(/^[a-z0-9_-]+\.eml$/u).meta({
    description: "File name under test/fixtures/mail/.",
  }),
  now: z.iso.datetime({ offset: true }).optional(),
  time_zone: z.string().optional(),
  expect: z.array(z.record(z.string(), z.unknown())).meta({
    description:
      "Expected results (subset match, in order) of parseEmail for the fixture; [] means no result.",
  }),
});

export const mailRuleSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().min(1),
  kind: mailKindSchema,
  senders: sendersSchema,
  flags: z.array(regexFlagSchema).default(["i"]).meta({
    description: "Flags for every bare-string pattern in this rule.",
  }),
  subject: z.array(regexLikeSchema).optional().meta({
    description: "If set, at least one must match the subject.",
  }),
  exclude: z.array(regexLikeSchema).optional().meta({
    description: "If any matches the subject, the rule does not apply.",
  }),
  body: z.array(regexLikeSchema).optional().meta({
    description:
      "If set, at least one must match the text (or the HTML as text); for senders such as " +
      "marketplaces that relay emails of several carriers.",
  }),
  extract: z.partialRecord(mailFieldSchema, z.array(extractSpecSchema).min(1)).default({}),
  status_keywords: z.array(statusKeywordSchema).default([]).meta({
    description: "Checked in order; the first group with a matching pattern sets the status.",
  }),
  event_keywords: z.array(eventKeywordSchema).default([]),
  default_status: parcelStatusSchema.optional(),
  carrier: identifierSchema.optional().meta({
    description: "The carrier when the email names none (see carrier_from).",
  }),
  carrier_from: z.literal("carrier").optional().meta({
    description:
      "Take the carrier from the extracted carrier field, normalised via carriers.yaml " +
      "aliases; falls back to `carrier`.",
  }),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u)
    .optional()
    .meta({
      description:
        "ISO 4217 code for a total whose text names no currency (or only $, which is USD " +
        "otherwise).",
    }),
  extractors: z.array(z.string()).default([]).meta({
    description: "Named code extractors (src/mail/extractors) for what a regex cannot express.",
  }),
  require: z.array(mailFieldSchema).default([]).meta({
    description: "Fields that must be found for the rule to produce a result.",
  }),
  tests: z.array(mailTestSchema).min(1),
});

export type MailRule = z.infer<typeof mailRuleSchema>;
export type MailRuleInput = z.input<typeof mailRuleSchema>;
export type EmailKind = z.infer<typeof mailKindSchema>;
export type EmailEvent = z.infer<typeof mailEventSchema>;
export type MailField = z.infer<typeof mailFieldSchema>;
export type MailPart = (typeof MAIL_PARTS)[number];
