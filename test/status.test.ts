import { describe, expect, it } from "vitest";
import { ignoredStatus, mapStatus, pastDayOffset, resolveStatus } from "../src/index.ts";
import { compileStatusTable, mapWithTable, resolveWithTable } from "../src/status.ts";
import { statusFileSchema } from "../src/schema/status.ts";
import type { RawStatus } from "../src/types.ts";
import { testData, testRules } from "./helpers/rules.ts";

const rules = testRules();

describe("status table vectors", () => {
  for (const file of testData().status) {
    describe(file.carrier, () => {
      for (const vector of file.tests) {
        const label = vector.input.code ?? vector.input.text ?? "";
        it(`${label} -> ${vector.status ?? "unmapped"}`, () => {
          const mapped = mapStatus(rules, file.carrier, vector.input);
          expect(mapped?.status ?? null).toBe(vector.status);
          if (vector.pickup !== undefined) expect(mapped?.pickup ?? false).toBe(vector.pickup);
          if (vector.stage !== undefined) expect(mapped?.stage).toBe(vector.stage);
          if (vector.label !== undefined) expect(mapped?.label).toBe(vector.label);
          if (vector.ignored !== undefined) {
            expect(ignoredStatus(rules, file.carrier, vector.input)).toBe(vector.ignored);
          }
        });
      }
    });
  }

  it("has tables for the first five carriers", () => {
    const carriers = testData().status.map((file) => file.carrier);
    expect(carriers).toEqual(expect.arrayContaining(["amazon", "dhl", "dpd", "gls", "hermes"]));
  });

  it("only names carriers that exist in the registry", () => {
    for (const file of testData().status) expect(rules.carriers.byId.has(file.carrier)).toBe(true);
  });
});

describe("mapStatus", () => {
  it("accepts carrier names and aliases", () => {
    expect(mapStatus(rules, "DHL Paket", { code: "fortschritt:5" })?.status).toBe("delivered");
    expect(mapStatus(rules, "myHermes", { code: "ZUGESTELLT" })?.status).toBe("delivered");
  });

  it("reports plausible guesses as unconfirmed", () => {
    expect(mapStatus(rules, "amazon", { code: "PICKUP_AVAILABLE" })).toEqual({
      status: "at_pickup_point",
      pickup: true,
      confirmed: false,
    });
    expect(mapStatus(rules, "amazon", { code: "DELIVERED" })).toEqual({
      status: "delivered",
      confirmed: true,
    });
  });

  it("tries the code before the text", () => {
    const mapped = mapStatus(rules, "dpd", { code: "DODEI", text: "Paket zugestellt" });
    expect(mapped?.status).toBe("at_pickup_point");
    expect(mapStatus(rules, "dpd", { code: "NOPE", text: "Paket zugestellt" })?.status).toBe(
      "delivered",
    );
  });

  it("returns null for carriers without a table and for empty input", () => {
    expect(mapStatus(rules, "nonexistent", { code: "DELIVERED" })).toBeNull();
    expect(mapStatus(rules, "dhl", {})).toBeNull();
    expect(mapStatus(rules, "dhl", { code: "  ", text: "" })).toBeNull();
  });
});

describe("match kinds", () => {
  const table = compileStatusTable({
    carrier: "example",
    entries: [
      { match: { fields: { kind: "OK", step: "32" } }, status: "at_pickup_point", pickup: true },
      { match: { fields: { kind: "OK" } }, status: "delivered" },
      { match: { code: "RETURN_LABEL" }, status: "registered" },
      { match: { code_prefix: "RETURN_" }, status: "returning" },
      { match: { code_prefix: "R" }, status: "problem" },
      { match: { text: "zugestellt", flags: ["i"] }, status: "delivered" },
    ],
    ignore: [],
  });
  const map = (raw: RawStatus) => mapWithTable(table, raw)?.status ?? null;

  it("tries fields first, most specific entry as listed", () => {
    expect(map({ fields: { kind: "OK", step: " 32 " } })).toBe("at_pickup_point");
    expect(map({ fields: { kind: "OK", step: "51" } })).toBe("delivered");
    expect(map({ fields: { kind: "ok" } })).toBeNull();
    expect(map({ fields: { kind: "OTHER" }, code: "RETURN_X" })).toBe("returning");
  });

  it("prefers an exact code over a prefix, and the first prefix in file order", () => {
    expect(map({ code: "RETURN_LABEL" })).toBe("registered");
    expect(map({ code: "return_delivered" })).toBe("returning");
    expect(map({ code: "REFUSED" })).toBe("problem");
    expect(map({ code: "XRETURN_" })).toBeNull();
  });

  it("names unmapped fields in the resolution", () => {
    expect(resolveWithTable(table, { fields: { kind: "NEW" } }, []).unmapped).toBe("kind=NEW");
  });
});

describe("the status file schema", () => {
  const file = (match: object) => ({
    carrier: "dhl",
    entries: [{ match, status: "delivered" }],
    tests: [{ input: { code: "X" }, status: null }],
  });

  it("refuses a code or prefix of only whitespace, which would match every code", () => {
    expect(statusFileSchema.safeParse(file({ code_prefix: "  " })).success).toBe(false);
    expect(statusFileSchema.safeParse(file({ code: " \t" })).success).toBe(false);
    expect(statusFileSchema.safeParse(file({ code_prefix: " DL" })).success).toBe(true);
  });
});

describe("ignore entries", () => {
  it("keep ignored values out of the mapping", () => {
    const line = { text: "Storniert" };
    expect(ignoredStatus(rules, "amazon", line)).toBe("order_cancelled");
    expect(mapStatus(rules, "amazon", line)).toBeNull();
    expect(ignoredStatus(rules, "amazon", { text: "Zugestellt" })).toBeNull();
    expect(ignoredStatus(rules, "no-such-carrier", line)).toBeNull();
  });
});

describe("pastDayOffset", () => {
  it("reads standalone past days in any loaded locale, or the named ones", () => {
    expect(pastDayOffset(rules, "Yesterday")).toBe(-1);
    expect(pastDayOffset(rules, "heute")).toBe(0);
    expect(pastDayOffset(rules, "gestern", ["en"])).toBeUndefined();
    expect(pastDayOffset(rules, "gestern", ["de-DE"])).toBe(-1);
    expect(pastDayOffset(rules, "tomorrow")).toBeUndefined();
  });
});

describe("resolveStatus", () => {
  it("uses the latest event when it maps", () => {
    expect(
      resolveStatus(rules, "hermes", { code: "ZUSTELLTOUR" }, [{ code: "UNTERWEGS" }]),
    ).toEqual({
      status: "out_for_delivery",
      source: "latest",
      unmapped: null,
    });
  });

  it("falls back to the newest history entry that maps and names the unmapped value", () => {
    const history = [{ code: "SOMETHING_NEW" }, { code: "SORTED" }, { code: "ANNOUNCED" }];
    expect(resolveStatus(rules, "hermes", { code: "SOMETHING_NEW" }, history)).toEqual({
      status: "in_transit",
      source: "history",
      unmapped: "SOMETHING_NEW",
    });
  });

  it("does not regress on a booking that is deliberately unmapped", () => {
    const result = resolveStatus(rules, "hermes", { code: "EDL_BOOKED_DROPOFF" }, [
      { code: "EDL_BOOKED_DROPOFF" },
      { code: "ARRIVED_AT_DELIVERY_DEPOT" },
    ]);
    expect(result.status).toBe("in_transit");
  });

  it("treats a value mapped to unknown as no information, without a warning", () => {
    expect(resolveStatus(rules, "dhl", { code: "unknown" }, [{ code: "transit" }])).toEqual({
      status: "in_transit",
      source: "history",
      unmapped: null,
    });
  });

  it("skips history entries mapped to unknown (the latest event repeated)", () => {
    expect(
      resolveStatus(rules, "dhl", { code: "unknown" }, [{ code: "unknown" }, { code: "transit" }]),
    ).toEqual({ status: "in_transit", source: "history", unmapped: null });
  });

  it("ends at unknown when nothing maps", () => {
    expect(resolveStatus(rules, "gls", { text: "???" }, [{ text: "!!!" }])).toEqual({
      status: "unknown",
      source: "unknown",
      unmapped: "???",
    });
    expect(resolveStatus(rules, "no-such-carrier", { code: "X" }, [])).toEqual({
      status: "unknown",
      source: "unknown",
      unmapped: "X",
    });
  });
});
