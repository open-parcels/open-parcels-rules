/*
 * schema.org ParcelDelivery markup, which some shops and carriers embed in mails as JSON-LD
 * or microdata. Costs one substring check when absent.
 */
import type { Tag } from "./html.ts";
import { CloseFinder, decodeEntities, MAX_HTML, walkHtml } from "./html.ts";
import type { ParcelStatus } from "../types.ts";

export interface SchemaOrgDelivery {
  readonly trackingNumbers: string[];
  readonly orderNumbers: string[];
  readonly carrierName?: string;
  readonly trackingUrl?: string;
  readonly status?: ParcelStatus;
  readonly expectedFrom?: string;
  readonly expectedUntil?: string;
  readonly items: string[];
}

const DELIVERY_STATUS: Readonly<Record<string, ParcelStatus>> = {
  OrderInTransit: "in_transit",
  OrderDelivered: "delivered",
  OrderPickupAvailable: "at_pickup_point",
  OrderProblem: "problem",
  OrderReturned: "returning",
  OrderProcessing: "registered",
  OrderPaymentDue: "registered",
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deeper JSON-LD is not schema.org markup; the walk stops there instead of overflowing. */
const MAX_DEPTH = 32;
/** A JSON-LD block longer than this is not parsed. */
const MAX_BLOCK = 256_000;

function text(value: Json | undefined): string | undefined {
  let current = value;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (typeof current === "string") return current.trim() || undefined;
    if (typeof current === "number") return String(current);
    if (!isObject(current)) return undefined;
    const name = current["name"];
    // {"name": ...} wins; an object without a usable name falls back to its @id.
    if (name !== undefined && (typeof name !== "string" || name.trim() !== "")) current = name;
    else current = current["@id"];
  }
  return undefined;
}

function typeNames(node: Record<string, Json>): string[] {
  const type = node["@type"];
  const list = Array.isArray(type) ? type : [type];
  return list.filter((entry): entry is string => typeof entry === "string");
}

/** Every ParcelDelivery node, walked iteratively and no deeper than MAX_DEPTH. */
function collectDeliveries(root: Json, found: Record<string, Json>[]): void {
  const stack: { value: Json; depth: number }[] = [{ value: root, depth: 0 }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, depth } = next;
    if (depth > MAX_DEPTH) continue;
    let children: Json[] = [];
    if (Array.isArray(value)) children = value;
    else if (isObject(value)) {
      if (typeNames(value).some((name) => name.endsWith("ParcelDelivery"))) found.push(value);
      children = Object.values(value);
    }
    // Reversed onto the stack, so nodes are found in document order.
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push({ value: child, depth: depth + 1 });
    }
  }
}

function statusOf(value: Json | undefined): ParcelStatus | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const key = raw.replace(/^.*[/#:]/u, "");
  return DELIVERY_STATUS[key];
}

function fromJsonLd(node: Record<string, Json>): SchemaOrgDelivery {
  const order = node["partOfOrder"];
  const item = node["itemShipped"];
  const items = (Array.isArray(item) ? item : [item]).map(text).filter((v) => v !== undefined);
  const tracking = text(node["trackingNumber"]);
  const orderNumber = isObject(order) ? text(order["orderNumber"]) : undefined;
  const carrierName = text(node["carrier"]) ?? text(node["provider"]);
  const trackingUrl = text(node["trackingUrl"]);
  const status = statusOf(node["deliveryStatus"]);
  const expectedFrom = text(node["expectedArrivalFrom"]);
  const expectedUntil = text(node["expectedArrivalUntil"]);
  return {
    trackingNumbers: tracking === undefined ? [] : [tracking],
    orderNumbers: orderNumber === undefined ? [] : [orderNumber],
    items,
    ...(carrierName === undefined ? {} : { carrierName }),
    ...(trackingUrl === undefined ? {} : { trackingUrl }),
    ...(status === undefined ? {} : { status }),
    ...(expectedFrom === undefined ? {} : { expectedFrom }),
    ...(expectedUntil === undefined ? {} : { expectedUntil }),
  };
}

function tagsOf(html: string): Tag[] {
  const tags: Tag[] = [];
  walkHtml(html, (tag) => tags.push(tag));
  return tags;
}

function jsonLdBlocks(html: string, tags: readonly Tag[]): Json[] {
  const source = html.slice(0, MAX_HTML);
  const closes = new CloseFinder(source);
  const blocks: Json[] = [];
  for (const tag of tags) {
    if (tag.closing || tag.name !== "script") continue;
    if (!/\btype\s*=\s*["']application\/ld\+json["']/iu.test(tag.source)) continue;
    const end = closes.find("script", tag.end);
    if (end < 0 || end - tag.end > MAX_BLOCK) continue;
    try {
      blocks.push(JSON.parse(source.slice(tag.end, end)) as Json);
    } catch {
      // Broken markup in one mail is the sender's problem; the other blocks still count.
      continue;
    }
  }
  return blocks;
}

function itemprop(html: string, tags: readonly Tag[], name: string): string | undefined {
  const pattern = new RegExp(`\\bitemprop\\s*=\\s*["']${name}["']`, "iu");
  const tag = tags.find((candidate) => pattern.test(candidate.source));
  if (tag === undefined) return undefined;
  const attribute = /\b(?:content|href)\s*=\s*["']([^"']*)["']/iu.exec(tag.source);
  if (attribute?.[1] !== undefined) return decodeEntities(attribute[1]).trim() || undefined;
  const next = html.indexOf("<", tag.end);
  const after = html.slice(tag.end, next < 0 ? undefined : next);
  return decodeEntities(after).trim() || undefined;
}

function fromMicrodata(html: string, tags: readonly Tag[]): SchemaOrgDelivery | null {
  const itemtype = /\bitemtype\s*=\s*["'][^"']*ParcelDelivery["']/iu;
  if (!tags.some((tag) => itemtype.test(tag.source))) return null;
  const tracking = itemprop(html, tags, "trackingNumber");
  const orderNumber = itemprop(html, tags, "orderNumber");
  const trackingUrl = itemprop(html, tags, "trackingUrl");
  const status = statusOf(itemprop(html, tags, "deliveryStatus"));
  return {
    trackingNumbers: tracking === undefined ? [] : [tracking],
    orderNumbers: orderNumber === undefined ? [] : [orderNumber],
    items: [],
    ...(trackingUrl === undefined ? {} : { trackingUrl }),
    ...(status === undefined ? {} : { status }),
  };
}

export function extractSchemaOrg(html: string | undefined): SchemaOrgDelivery[] {
  if (!html?.includes("ParcelDelivery")) return [];
  const tags = tagsOf(html);
  const nodes: Record<string, Json>[] = [];
  for (const block of jsonLdBlocks(html, tags)) collectDeliveries(block, nodes);
  const deliveries = nodes.map(fromJsonLd);
  const micro = deliveries.length === 0 ? fromMicrodata(html, tags) : null;
  return micro === null ? deliveries : [micro];
}
