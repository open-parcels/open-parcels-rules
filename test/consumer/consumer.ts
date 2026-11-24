// Type-checked by the smoke test against the built declarations, as a consumer would see them.
import {
  carriers,
  detectTrackingNumbers,
  findCarrier,
  loadRules,
  mapStatus,
  parseArrival,
  parseEmail,
  resolveStatus,
  trackingUrl,
} from "../../dist/index.js";
import type {
  ArrivalWindow,
  CarrierInfo,
  EmailParseResult,
  ParcelStatus,
  Rules,
  TrackingCandidate,
} from "../../dist/index.js";

const rules: Rules = loadRules();
const all: CarrierInfo[] = carriers(rules);
const dhl: CarrierInfo | undefined = findCarrier(rules, "DHL Paket");
const url: string | undefined = trackingUrl(rules, "dhl", "00340434123456789012", "de");
const found: TrackingCandidate[] = detectTrackingNumbers(rules, "text", { country: "DE" });
const status: ParcelStatus | undefined = mapStatus(rules, "dhl", { code: "x" })?.status;
const resolved: "latest" | "history" | "unknown" = resolveStatus(rules, "dhl", {}, []).source;
const window: ArrivalWindow | null = parseArrival(rules, "heute", {
  now: new Date(),
  timeZone: "UTC",
});
const mails: EmailParseResult[] = parseEmail(rules, { from: "a@b.c", subject: "s" });

export const used = [all, dhl, url, found, status, resolved, window, mails];
