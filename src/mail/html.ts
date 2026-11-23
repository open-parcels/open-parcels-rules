/*
 * Just enough HTML-to-text for mail bodies: block elements become line breaks, links keep
 * their target in angle brackets, entities are decoded. Not a general HTML parser.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  euro: "€",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  shy: "",
  zwnj: "",
  copy: "©",
  reg: "®",
};

/** The character a numeric reference stands for; U+FFFD for NUL, surrogates and beyond Unicode. */
function codePoint(digits: string, radix: number): string {
  const value = Number.parseInt(digits, radix);
  const valid = value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
  return valid ? String.fromCodePoint(value) : "\uFFFD";
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return codePoint(body.slice(2), 16);
    if (body.startsWith("#")) return codePoint(body.slice(1), 10);
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** HTML beyond this many characters is not read; mails that size are not shipping notices. */
export const MAX_HTML = 2_000_000;

/** One `<...>` tag (or comment) of an HTML text, with its lower-case name ("" for none). */
export interface Tag {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
  readonly source: string;
}

const RAW_TEXT = new Set(["script", "style", "title"]);

/** Where `</name` (case-insensitive) next starts at or after `from`, remembering misses. */
export class CloseFinder {
  private readonly lower: string;
  private readonly missing = new Set<string>();

  constructor(html: string) {
    this.lower = html.toLowerCase();
  }

  find(name: string, from: number): number {
    if (this.missing.has(name)) return -1;
    const index = this.lower.indexOf(`</${name}`, from);
    if (index < 0) this.missing.add(name);
    return index;
  }
}

/**
 * Walks the tags of `html` in one linear pass. Comments are skipped (an unclosed one ends the
 * text); the content of script, style and title is skipped when they are closed. `onText` gets
 * the text between tags.
 */
export function walkHtml(
  html: string,
  onTag: (tag: Tag) => void,
  onText: (text: string) => void = () => undefined,
): void {
  const source = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;
  const closes = new CloseFinder(source);
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open < 0) break;
    if (source.startsWith("<!--", open)) {
      onText(source.slice(index, open));
      const close = source.indexOf("-->", open + 4);
      index = close < 0 ? source.length : close + 3;
      continue;
    }
    const close = source.indexOf(">", open + 1);
    // No ">" anywhere after this point: no later "<" can close either, the rest is text.
    if (close < 0) break;
    if (close === open + 1) {
      onText(source.slice(index, close + 1));
      index = close + 1;
      continue;
    }
    onText(source.slice(index, open));
    const text = source.slice(open, close + 1);
    const head = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/u.exec(text);
    const tag: Tag = {
      start: open,
      end: close + 1,
      name: head?.[2]?.toLowerCase() ?? "",
      closing: head?.[1] === "/",
      source: text,
    };
    onTag(tag);
    index = close + 1;
    if (!tag.closing && RAW_TEXT.has(tag.name)) {
      const end = closes.find(tag.name, index);
      const after = end < 0 ? -1 : source.indexOf(">", end);
      if (after >= 0) index = after + 1;
    }
  }
  if (index < source.length) onText(source.slice(index));
}

const BLOCK = new Set([
  "br",
  "p",
  "div",
  "tr",
  "li",
  "ul",
  "ol",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "footer",
]);
const CELL = new Set(["td", "th"]);
const HREF = /\bhref\s*=\s*["']([^"']*)["']/iu;

export function htmlToText(html: string): string {
  const parts: string[] = [];
  let href: string | null = null;
  // Nothing in <head> is shown; an unclosed one hides nothing.
  let inHead = false;
  const headClosed = /<\/head\b/iu.test(html.slice(0, MAX_HTML));
  walkHtml(
    html,
    (tag) => {
      if (tag.name === "head") inHead = !tag.closing && headClosed;
      else if (inHead) return;
      else if (tag.name === "a") {
        if (tag.closing) {
          if (href !== null) parts.push(` <${href}>`);
          href = null;
        } else {
          href = HREF.exec(tag.source)?.[1] ?? null;
        }
      } else if (BLOCK.has(tag.name)) parts.push("\n");
      else if (CELL.has(tag.name)) parts.push(" ");
    },
    (text) => {
      if (!inHead) parts.push(text);
    },
  );
  return decodeEntities(parts.join(""))
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
