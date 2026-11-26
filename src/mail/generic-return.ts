import type { Rules } from "../rules.ts";
import type { EmailEvent } from "../schema/mail.ts";
import type { EmailInput, EmailParseResult } from "../types.ts";
import { readReturn, returnItems, lines } from "./returns.ts";

/*
 * Return emails of shops no rule knows (shops on their own domain, often on a hosted shop
 * system: "Return requested for order #1042"). Read only when no rule, no markup and no ignore
 * rule applies, and only when the subject both speaks of a return or refund and names the order.
 * The result's rule id is `generic-return`; the order is the sender domain's.
 */

export const GENERIC_RETURN_RULE = "generic-return";

/** Return and refund wording of a subject, most decisive first. */
const SUBJECT_EVENTS: readonly (readonly [EmailEvent, RegExp])[] = [
  [
    "return_rejected",
    /\breturn(?: request)? (?:was |has been )?(?:declined|rejected|denied)\b|rücksendung (?:wurde )?abgelehnt|retoure (?:wurde )?abgelehnt/iu,
  ],
  [
    "refund_issued",
    /\b(?:refund(?:ed)?|money back)\b(?! request)|rückerstattung|erstattung|gutschrift|geld zurück/iu,
  ],
  [
    "return_received",
    /\breturn (?:was |has been )?received\b|rücksendung (?:ist )?(?:eingegangen|erhalten)|retoure (?:ist )?(?:eingegangen|erhalten)/iu,
  ],
  [
    "return_started",
    /\breturn (?:request(?:ed)?|approved|accepted|label|started|created|confirmed)\b|rücksendung|retoure|rückgabe/iu,
  ],
];

/** An order number the subject labels: "order #1042", "Bestellung 12345", "Order No. A-77". */
const ORDER_NUMBER =
  /\b(?:order|bestellung|auftrag)\s*(?:no\.?|number|nr\.?|nummer)?\s*[:#]?\s*#?(?<number>[A-Z0-9-]*\d[A-Z0-9-]*)\b/iu;

export function genericReturn(
  rules: Rules,
  mail: EmailInput,
  parts: { readonly subject: string; readonly text: string },
): EmailParseResult | null {
  const event = SUBJECT_EVENTS.find(([, wording]) => wording.test(parts.subject))?.[0];
  if (event === undefined) return null;
  const orderNumber = ORDER_NUMBER.exec(parts.subject)?.groups?.["number"];
  if (orderNumber === undefined || orderNumber.length < 3) return null;
  const items = returnItems(parts.subject, lines(parts.text));
  return {
    ruleId: GENERIC_RETURN_RULE,
    kind: "return",
    trackingNumbers: [],
    orderNumbers: [orderNumber],
    event,
    ...(items.length === 0 ? {} : { items }),
    return: readReturn(rules, mail, parts.text, event),
  };
}
