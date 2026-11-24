import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../scripts/collect.ts";
import { detectTrackingNumbers, findCarrier, mapStatus, parseMoney } from "../src/index.ts";
import type { Money, RawStatus } from "../src/types.ts";
import { testRules } from "./helpers/rules.ts";

/*
 * The parity vectors pin what this engine answers on inputs where a port is easy to get wrong
 * (accents, U+FEFF, line separators, missing fields). The Python loader runs the same file.
 */
interface Parity {
  names: { name: string; carrier: string }[];
  detect: { text: string; numbers: string[] }[];
  status: { carrier: string; input: RawStatus; status: string | null }[];
  money: { text: string; currency?: string; total: Money | null }[];
}

const parity = JSON.parse(
  readFileSync(join(ROOT, "test", "fixtures", "parity-vectors.json"), "utf8"),
) as Parity;
const rules = testRules();

describe("parity vectors", () => {
  it.each(parity.names)("$name names $carrier", ({ name, carrier }) => {
    expect(findCarrier(rules, name)?.id).toBe(carrier);
  });

  it.each(parity.detect)("finds $numbers in $text", ({ text, numbers }) => {
    const found = [...new Set(detectTrackingNumbers(rules, text).map((c) => c.trackingNumber))];
    expect(found.sort()).toEqual(numbers);
  });

  it.each(parity.status)("maps $input for $carrier", ({ carrier, input, status }) => {
    expect(mapStatus(rules, carrier, input)?.status ?? null).toBe(status);
  });

  it.each(parity.money)("reads $text as $total", ({ text, currency, total }) => {
    expect(parseMoney(text, currency) ?? null).toEqual(total);
  });
});
