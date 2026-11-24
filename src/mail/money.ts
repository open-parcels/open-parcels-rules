import type { Money } from "../types.ts";

/**
 * Reads an amount of money as an email writes it ("€ 11,47", "1.234,50 EUR", "99.90EUR",
 * "$12.00"). The Python loader ports this function; the parity vectors pin both.
 */

/** ISO 4217 codes recognised in the text; anything else needs the rule's `currency`. */
const CODES = /(?<![A-Z])(EUR|USD|GBP|PLN|CHF|CZK|SEK|DKK|NOK|HUF|AUD|CAD|CNY|JPY)(?![A-Z])/u;
const SYMBOLS: readonly (readonly [string, string])[] = [
  ["€", "EUR"],
  ["£", "GBP"],
  ["zł", "PLN"],
  ["Kč", "CZK"],
];
/** Digits with thousands or decimal separators (dot, comma, apostrophe, spaces). */
const NUMBER = /\d(?:[\d.,' \u00a0\u202f]*\d)?/u;
const GROUPING = /[' \u00a0\u202f]/gu;

function currencyOf(text: string, fallback: string | undefined): string | undefined {
  const code = CODES.exec(text)?.[1];
  if (code !== undefined) return code;
  const symbol = SYMBOLS.find(([sign]) => text.includes(sign));
  if (symbol !== undefined) return symbol[1];
  // "$" alone is US dollars unless the rule says which dollars its shop means.
  if (text.includes("$")) return fallback ?? "USD";
  return fallback;
}

function amountOf(text: string): number | undefined {
  const digits = NUMBER.exec(text)?.[0].replace(GROUPING, "");
  if (digits === undefined) return undefined;
  const last = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
  // One or two digits after the last separator make it the decimal point; three, a grouping.
  const decimals = last < 0 ? "" : digits.slice(last + 1);
  const whole = decimals.length > 0 && decimals.length <= 2 ? digits.slice(0, last) : digits;
  const fraction = whole === digits ? "" : decimals;
  const integer = whole.replace(/[.,]/gu, "");
  if (!/^\d+$/u.test(integer)) return undefined;
  return Number(fraction === "" ? integer : `${integer}.${fraction}`);
}

/** The amount and ISO 4217 currency in `text`, or undefined when either is missing. */
export function parseMoney(text: string, currency?: string): Money | undefined {
  const amount = amountOf(text);
  const code = currencyOf(text, currency);
  return amount === undefined || code === undefined ? undefined : { amount, currency: code };
}
