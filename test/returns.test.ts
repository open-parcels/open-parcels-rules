import { describe, expect, it } from "vitest";
import { GENERIC_RETURN_RULE, parseEmail } from "../src/index.ts";
import { readReturn } from "../src/mail/returns.ts";
import type { EmailInput } from "../src/types.ts";
import { testRules } from "./helpers/rules.ts";

/*
 * Made-up return and refund emails. Their layout follows real shops' emails (labelled lines,
 * links on their own line or in brackets); every name, number, address and link is invented.
 */
const rules = testRules();
const ORDER = "302-0000000-0000001";

function mail(subject: string, text: string, from = "returns@shop.example.com"): EmailInput {
  return {
    from,
    subject,
    text,
    date: new Date("2026-11-18T09:00:00Z"),
    timeZone: "Europe/Berlin",
  };
}

function read(subject: string, text: string, event?: "return_started" | "refund_issued") {
  return readReturn(rules, mail(subject, text), text, event);
}

const REQUESTED_EN = [
  "Hello Example Person, Your return request is confirmed. Drop-off: You can drop off your return by Dec 2. Location: Any DHL Drop Off. Your refund will be issued after drop-off.",
  "Return code",
  `[Click here for Return Code](https://shop.example.com/returns/prep?rmaId=DExampleRMA1&orderId=${ORDER})`,
  "Total estimated refund* €24.99",
  "FREE return: You can return the item without any shipping charges.",
  "Drop off by:",
  "2. December 2026",
  "Drop-off Location",
  "DHL Drop off – no printer required",
].join("\n");

const REQUESTED_DE = [
  "Hallo Example Person, Ihr Rücksendeantrag wurde bestätigt.",
  "Rücksendeetikett",
  `Etikett drucken (https://shop.example.com/returns/prep?rmaId=DExampleRMA2&orderId=${ORDER})`,
  "Gesamtbetrag Erstattung: 129,90 €^",
  "Rücksendekosten: 4,99 €",
  "Rückgabe bis:",
  "10. Dezember 2026",
  "Abgabestandort",
  "Abgabe in einer Packstation von DHL",
].join("\n");

describe("return details", () => {
  it("reads a request: deadline, drop-off, free return, label, refund and return id", () => {
    const details = read("Your return of Example headphones", REQUESTED_EN, "return_started");
    expect(details).toMatchObject({
      status: "requested",
      returnId: "DExampleRMA1",
      returnBy: "2026-12-02",
      cost: { free: true },
      refund: { amount: 24.99, currency: "EUR" },
      aboutReturn: true,
    });
    expect(details.labelUrl).toMatch(/^https:\/\/shop\.example\.com\/returns\/prep\?/u);
    expect(details.dropOff).toEqual([
      { carrier: "dhl", kind: "any", description: "Any DHL Drop Off" },
      { carrier: "dhl", kind: "shop", description: "DHL Drop off – no printer required" },
    ]);
  });

  it("reads a German request with a paid return to a parcel locker", () => {
    const details = read("Ihre Rücksendung von Beispiel-Lampe", REQUESTED_DE, "return_started");
    expect(details).toMatchObject({
      returnId: "DExampleRMA2",
      returnBy: "2026-12-10",
      cost: { free: false, amount: 4.99, currency: "EUR" },
      refund: { amount: 129.9, currency: "EUR" },
    });
    expect(details.dropOff).toEqual([
      { carrier: "dhl", kind: "parcel_locker", description: "Abgabe in einer Packstation von DHL" },
    ]);
  });

  it("reads how far the return is from the wording", () => {
    expect(read("Drop-off", "Your return was dropped off. Your return is in-transit.").status).toBe(
      "in_transit",
    );
    expect(read("Your return label", "Print it.", "return_started").status).toBe("label_created");
    expect(read("Refund", "Your return has been cancelled.", "refund_issued").status).toBe(
      "cancelled",
    );
    expect(read("Your refund", "Money back.", "refund_issued")).toMatchObject({
      status: "refunded",
      aboutReturn: false,
    });
  });
});

describe("return emails of shops no rule knows", () => {
  const summary = "Your return request was sent and is being reviewed.\nItem: Example battery pack";

  it("reads a request, a decline and a refund that name the order in the subject", () => {
    expect(parseEmail(rules, mail("Return requested for order #3100042", summary))).toEqual([
      expect.objectContaining({
        ruleId: GENERIC_RETURN_RULE,
        kind: "return",
        event: "return_started",
        orderNumbers: ["3100042"],
        items: ["Example battery pack"],
        return: expect.objectContaining({ status: "requested" }) as unknown,
      }),
    ]);
    expect(
      parseEmail(rules, mail("Return request declined for order #3100042", "Sorry."))[0],
    ).toMatchObject({ event: "return_rejected", return: { status: "rejected" } });
    expect(
      parseEmail(rules, mail("Rückerstattung zu Ihrer Bestellung 3100042", "Erstattet."))[0],
    ).toMatchObject({ event: "refund_issued", orderNumbers: ["3100042"] });
  });

  it("leaves emails without a return word or an order number alone", () => {
    expect(parseEmail(rules, mail("Return to our club and play today!", "Offer"))).toEqual([]);
    expect(parseEmail(rules, mail("Your refund has been approved", "Money back."))).toEqual([]);
    expect(parseEmail(rules, mail("Your order #3100042 has shipped", "On its way."))).toEqual([]);
  });
});
