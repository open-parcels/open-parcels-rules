import { parseWithGrammar } from "../arrival/parse.ts";
import { lookupCarrier } from "../carriers.ts";
import type { Rules } from "../rules.ts";
import { grammarFor } from "../rules.ts";
import type { EmailEvent } from "../schema/mail.ts";
import type {
  DropOffKind,
  DropOffOption,
  EmailInput,
  ReturnCost,
  ReturnDetails,
  ReturnStatus,
} from "../types.ts";
import { parseMoney } from "./money.ts";

/*
 * What a return or refund email says beyond its rule's fields: the return-by day, where to drop
 * it off, the cost, the refund, the label link, the shop's return id and reason, and how far the
 * return is. Read from labelled lines ("Drop off by:", "Rückgabe bis:") in English and German, so
 * every return rule (and every provider's) gets them without spelling them out.
 */

/** The text as trimmed, non-empty lines. */
export function lines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line !== "");
}

/** What follows a label: the rest of its line, else the next line. */
function after(list: readonly string[], label: RegExp): string | undefined {
  for (const [index, line] of list.entries()) {
    const match = label.exec(line);
    if (match === null) continue;
    const rest = line
      .slice(match.index + match[0].length)
      .replace(/^\s*[:#*^]?\s*/u, "")
      .trim();
    if (rest !== "") return rest;
    const next = list[index + 1];
    if (next !== undefined) return next;
  }
  return undefined;
}

const RETURN_BY_LABEL =
  /\b(?:send by|drop off by|return by|ship by|rückgabe bis|abgabe bis|zurücksenden bis|rücksendung bis(?: zum)?)\b/iu;
const RETURN_BY_INLINE =
  /\b(?:drop off your return by|return (?:it|the items?) by|rücksendung bis zum|bis zum)\s+([^.;]{3,40})/iu;

function returnBy(rules: Rules, list: readonly string[], mail: EmailInput): string | undefined {
  const grammar = grammarFor(rules);
  if (grammar === null || mail.date === undefined) return undefined;
  const labelled = after(list, RETURN_BY_LABEL);
  const inline = list.map((line) => RETURN_BY_INLINE.exec(line)?.[1]).find((v) => v !== undefined);
  for (const text of [labelled, inline]) {
    if (text === undefined) continue;
    const window = parseWithGrammar(grammar, text, mail.date, mail.timeZone ?? "UTC");
    if (window !== null) return window.from.slice(0, 10);
  }
  return undefined;
}

const DROP_OFF_LABELS = [
  /\b(?:location|ort)\s*:/iu,
  /\b(?:drop-off location|abgabestandort|abgabeort|return (?:dispatch|shipping) method|rücksendemethode|rücksendeoption)\b/iu,
];

function dropOffKind(text: string): DropOffKind {
  if (/\b(?:any|beliebige[rn]?|jede[rn]?)\b/iu.test(text)) return "any";
  if (/packstation|locker|paketautomat|parcel ?box|paketbox/iu.test(text)) return "parcel_locker";
  if (/post ?office|postfiliale|filiale|postamt/iu.test(text)) return "post_office";
  if (/pick ?up|abholung/iu.test(text)) return "pickup";
  return "shop";
}

/** The carrier a drop-off text names: one or two words looked up in the carrier list. */
function namedCarrier(rules: Rules, text: string): string | undefined {
  const words = text.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);
  for (const [index, word] of words.entries()) {
    const pair = words[index + 1];
    const found =
      (pair === undefined ? undefined : lookupCarrier(rules.carriers, `${word} ${pair}`)) ??
      lookupCarrier(rules.carriers, word);
    if (found !== undefined) return found.id;
  }
  return undefined;
}

function dropOff(rules: Rules, list: readonly string[]): DropOffOption[] {
  const options: DropOffOption[] = [];
  for (const label of DROP_OFF_LABELS) {
    // An inline "Location: Any DHL Drop Off. Your refund …" ends at its sentence.
    const text = after(list, label)
      ?.split(/\.(?:\s|$)/u)[0]
      ?.trim()
      .slice(0, 200);
    if (text === undefined || text === "") continue;
    if (options.some((option) => option.description.toLowerCase() === text.toLowerCase())) {
      continue;
    }
    const carrier = namedCarrier(rules, text);
    options.push({
      ...(carrier === undefined ? {} : { carrier }),
      kind: dropOffKind(text),
      description: text,
    });
  }
  return options;
}

const FREE =
  /\bfree return\b|\breturn is free\b|kostenlose? (?:rücksendung|rückgabe)|kostenlos zurück|free of charge/iu;
const COST_LABEL =
  /\b(?:return (?:shipping )?(?:cost|fee|charge)|rücksendekosten|rücksendegebühr|kosten für die rücksendung)\b/iu;

function cost(list: readonly string[]): ReturnCost | undefined {
  if (list.some((line) => FREE.test(line))) return { free: true };
  const text = after(list, COST_LABEL);
  const money = text === undefined ? undefined : parseMoney(text);
  if (money === undefined) return undefined;
  return { free: money.amount === 0, amount: money.amount, currency: money.currency };
}

const REFUND_LABEL =
  /\b(?:total estimated refund|estimated refund|total refund|refund total|amount refunded|summe der rückerstattung|betrag in höhe von|refund amount|refund in the amount of|gesamtbetrag erstattung|geschätzte erstattung|erstattungsbetrag|erstattung in höhe von|rückerstattung in höhe von|erstatteter betrag)\b/iu;

const URL = /https?:\/\/[^\s)<>"\]]+/iu;
const LABEL_LINK = /return label|return code|rückgabecode|rücksendeetikett|etikett|qr[ -]?code/iu;

/** The label or QR-code page: the first link on, or right after, a line that names one. */
function labelUrl(list: readonly string[]): string | undefined {
  for (const [index, line] of list.entries()) {
    if (!LABEL_LINK.test(line)) continue;
    const url = URL.exec(line)?.[0] ?? URL.exec(list[index + 1] ?? "")?.[0];
    if (url !== undefined) return url;
  }
  return undefined;
}

/** The shop's own id of the return: a link parameter or a labelled number. */
function returnId(list: readonly string[]): string | undefined {
  for (const line of list) {
    const ref =
      /[?&]rmaId=([A-Za-z0-9]{6,40})/u.exec(line)?.[1] ??
      /\b(?:return (?:id|number)|rücksendenummer|rma)\s*[:#]\s*([A-Z0-9-]{5,40})\b/iu.exec(
        line,
      )?.[1];
    if (ref !== undefined) return ref;
  }
  return undefined;
}

function reason(list: readonly string[]): string | undefined {
  return after(
    list,
    /\b(?:reason for (?:return|refund)|rückgabegrund|grund der rücksendung)\b/iu,
  )?.slice(0, 200);
}

/** Item titles a return email names on "Item: …" lines, else in its subject. */
export function returnItems(subject: string, list: readonly string[]): string[] {
  const listed = list
    .map((line) => /^(?:item|artikel)\s*:\s*(.{2,200})$/iu.exec(line)?.[1]?.trim())
    .filter((title): title is string => title !== undefined);
  if (listed.length > 0) return listed;
  const named = /\b(?:return of|refund for|rücksendung von|erstattung für)\s+(.{2,200})$/iu.exec(
    subject,
  )?.[1];
  return named === undefined ? [] : [named.replace(/\s+/gu, " ").trim()];
}

/**
 * How far the return is by the email's wording, else by the rule's event. An email can say more
 * than its rule's keyword: a drop-off confirmation reads `return_started` by its subject.
 */
function status(
  event: EmailEvent | undefined,
  subject: string,
  list: readonly string[],
): ReturnStatus | undefined {
  const body = list.join("\n");
  if (/\byour return (?:was|has been) cancell?ed\b|rücksendung (?:wurde )?storniert/iu.test(body)) {
    return "cancelled";
  }
  if (event === "refund_issued") return "refunded";
  if (event === "return_rejected") return "rejected";
  if (event === "return_received") return "received";
  if (/\bis in[- ]transit\b|ist (?:jetzt )?unterwegs/iu.test(body)) return "in_transit";
  if (
    /\bwas dropped off\b|wurde abgegeben|drop-off confirmation|abgabebestätigung/iu.test(
      `${subject}\n${body}`,
    )
  ) {
    return "dropped_off";
  }
  if (/return label|rücksendeetikett/iu.test(subject)) return "label_created";
  return event === "return_started" ? "requested" : undefined;
}

/** What a return or refund email says about the return (`EmailParseResult.return`). */
export function readReturn(
  rules: Rules,
  mail: EmailInput,
  text: string,
  event: EmailEvent | undefined,
): ReturnDetails {
  const list = lines(text);
  const stage = status(event, mail.subject, list);
  const id = returnId(list);
  const why = reason(list);
  const by = returnBy(rules, list, mail);
  const price = cost(list);
  const refundText = after(list, REFUND_LABEL);
  const refund = refundText === undefined ? undefined : parseMoney(refundText);
  const label = labelUrl(list);
  return {
    ...(stage === undefined ? {} : { status: stage }),
    ...(id === undefined ? {} : { returnId: id }),
    ...(why === undefined ? {} : { reason: why }),
    ...(by === undefined ? {} : { returnBy: by }),
    ...(price === undefined ? {} : { cost: price }),
    ...(refund === undefined ? {} : { refund }),
    ...(label === undefined ? {} : { labelUrl: label }),
    dropOff: dropOff(rules, list),
    aboutReturn: /\breturn|rücksend|rückgabe|retoure/iu.test(`${mail.subject}\n${text}`),
  };
}
