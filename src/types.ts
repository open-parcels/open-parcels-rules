import type { PARCEL_STATUSES } from "./schema/common.ts";
import type { EmailEvent, EmailKind } from "./schema/mail.ts";

export type ParcelStatus = (typeof PARCEL_STATUSES)[number];
export type { EmailEvent, EmailKind };

export interface CarrierInfo {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly countries: readonly string[];
  readonly domains: readonly string[];
  /** Locale key ('default', 'de', 'de-AT', ...) to URL template with {tracking_number}. */
  readonly trackingUrls: Readonly<Record<string, string>>;
  /** What the carrier's tracker accepts, compiled; undefined when not listed. */
  readonly trackingNumberPattern?: RegExp;
  /** Identifiers of the carrier in other systems, e.g. { "17track": "100001" }. */
  readonly crossref: Readonly<Record<string, string>>;
}

export interface DetectHints {
  /** Domain of the mail sender or page the text came from, e.g. "dhl.de". */
  readonly senderDomain?: string;
  /** A carrier name or alias mentioned near the number. */
  readonly carrier?: string;
  /** ISO 3166-1 alpha-2 country the parcel is shipped to or from. */
  readonly country?: string;
}

export interface TrackingCandidate {
  /** Carrier id from carriers.yaml, or "upu" for an S10 number of an unknown postal operator. */
  readonly carrier: string;
  /** The number without whitespace, upper-cased. */
  readonly trackingNumber: string;
  /** 0..1, comparable between candidates of one call. */
  readonly confidence: number;
  /** null when the format has no check digit. */
  readonly checksumValid: boolean | null;
  /** Ids of the matching formats, e.g. ["dhl_paket_nve"]. */
  readonly types: readonly string[];
}

export interface RawStatus {
  readonly code?: string | undefined;
  readonly text?: string | undefined;
  /** Named raw fields (e.g. { statusType: "STATUS_OK", statusCode: "32" }) for `fields` entries. */
  readonly fields?: Readonly<Record<string, string>> | undefined;
}

export interface CarrierKey {
  readonly carrier: string;
  readonly name: string;
  readonly purpose: string;
  readonly source: "website" | "app";
  /** ISO date (YYYY-MM-DD) the value was last seen working. */
  readonly lastVerified: string;
  readonly value: string;
}

export interface MappedStatus {
  readonly status: ParcelStatus;
  readonly pickup?: boolean;
  readonly confirmed: boolean;
  /** The entry's `stage` (order within the carrier's journey), when the table gives one. */
  readonly stage?: number;
  /** The entry's neutral display text, when the table gives one. */
  readonly label?: string;
}

export interface ResolvedStatus {
  readonly status: ParcelStatus;
  readonly source: "latest" | "history" | "unknown";
  /** The raw code or text of `latest` when it did not map; warn about it once. */
  readonly unmapped: string | null;
}

export interface ArrivalWindow {
  /** ISO 8601 with the offset of the requested time zone. */
  readonly from: string;
  /** ISO 8601 with offset; exclusive end for whole days (next day 00:00). */
  readonly to: string;
  readonly allDay: boolean;
  /** The part of the text the window was read from. */
  readonly matched: string;
}

export interface ArrivalOptions {
  readonly now: Date;
  /** IANA time zone the text's dates and times are in, e.g. "Europe/Berlin". */
  readonly timeZone: string;
  /** Locale tables to use (e.g. ["de"]); all loaded ones by default. */
  readonly locales?: readonly string[];
}

export interface EmailInput {
  /** The From header, either "addr@example.com" or "Name <addr@example.com>". */
  readonly from: string;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  /** When the mail was sent; the reference for relative dates such as "tomorrow". */
  readonly date?: Date;
  /** Time zone for arrival dates in the mail; defaults to UTC. */
  readonly timeZone?: string;
}

/** An amount of money with its ISO 4217 currency code. */
export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export interface EmailParseResult {
  /** Mail rule id, "schema.org" for embedded ParcelDelivery data, or "fallback". */
  readonly ruleId: string;
  readonly kind: EmailKind;
  readonly carrier?: string;
  readonly trackingNumbers: readonly string[];
  readonly orderNumbers: readonly string[];
  readonly status?: ParcelStatus;
  /** For order, return and dunning mails: what happened. */
  readonly event?: EmailEvent;
  readonly arrival?: ArrivalWindow;
  readonly items?: readonly string[];
  readonly trackingUrl?: string;
  /**
   * A code that unlocks a locker or proves identity at a pickup point. Sensitive: show it to
   * the recipient, but never write it to logs.
   */
  readonly pickupCode?: string;
  /** What the order costs in total, as the email states it. */
  readonly total?: Money;
  /**
   * The shop (or seller) the email names as the one paid, in its own words; payment services'
   * refund emails name no order number, but the payee and the amount paid.
   */
  readonly shop?: string;
  /** For return results: what the email says about the return. */
  readonly return?: ReturnDetails;
}

/** How far a return is. */
export type ReturnStatus =
  | "requested"
  | "label_created"
  | "dropped_off"
  | "in_transit"
  | "received"
  | "refunded"
  | "rejected"
  | "cancelled";

/** Where a return may be handed in. `any`: any shop or point of the carrier. */
export type DropOffKind = "shop" | "parcel_locker" | "post_office" | "pickup" | "any";

export interface DropOffOption {
  /** Carrier id, when the option names one. */
  readonly carrier?: string;
  readonly kind: DropOffKind;
  /** The shop's own words, e.g. "Any DHL drop-off". */
  readonly description: string;
}

/** Whether sending a return back is free, or what it costs. */
export interface ReturnCost {
  readonly free: boolean;
  readonly amount?: number;
  readonly currency?: string;
}

/** What a return or refund email says beyond its rule's fields (`src/mail/returns.ts`). */
export interface ReturnDetails {
  readonly status?: ReturnStatus;
  /** The shop's own id of the return. */
  readonly returnId?: string;
  readonly reason?: string;
  /** The last day to hand the return in, a local `YYYY-MM-DD` day. */
  readonly returnBy?: string;
  readonly dropOff: readonly DropOffOption[];
  readonly cost?: ReturnCost;
  /** The money paid back, or to be. */
  readonly refund?: Money;
  /** The label or QR-code page. */
  readonly labelUrl?: string;
  /** The email speaks of a return (not only of money back for a cancelled order). */
  readonly aboutReturn: boolean;
}
