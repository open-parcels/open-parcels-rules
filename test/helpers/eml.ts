/*
 * A small RFC 5322 / MIME reader for the test fixtures: headers with RFC 2047 encoded words,
 * multipart bodies, quoted-printable and base64. Enough for hand-written fixtures, no more.
 */
import type { EmailInput } from "../../src/types.ts";

interface Part {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

function splitHead(raw: string): Part {
  const normalized = raw.replace(/\r\n/gu, "\n");
  const end = normalized.indexOf("\n\n");
  const head = end < 0 ? normalized : normalized.slice(0, end);
  const body = end < 0 ? "" : normalized.slice(end + 2);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\n[ \t]+/gu, " ").split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  return new TextDecoder(charset.toLowerCase() === "us-ascii" ? "utf-8" : charset).decode(bytes);
}

function quotedPrintable(text: string, charset: string): string {
  const joined = text.replace(/=\n/gu, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/u.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(joined[i]));
    }
  }
  return decodeBytes(Uint8Array.from(bytes), charset);
}

function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/gu, "?==?")
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/gu,
      (_, charset: string, mode: string, text: string) =>
        mode.toUpperCase() === "B"
          ? decodeBytes(Buffer.from(text, "base64"), charset)
          : quotedPrintable(text.replace(/_/gu, " "), charset),
    );
}

function param(header: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "iu").exec(header)?.[1];
}

function decodeBody(part: Part): string {
  const type = part.headers.get("content-type") ?? "text/plain";
  const charset = param(type, "charset") ?? "utf-8";
  const encoding = (part.headers.get("content-transfer-encoding") ?? "").toLowerCase();
  if (encoding === "base64") return decodeBytes(Buffer.from(part.body, "base64"), charset);
  if (encoding === "quoted-printable") return quotedPrintable(part.body, charset);
  return part.body;
}

function collectParts(part: Part, out: { text?: string; html?: string }): void {
  const type = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
  const boundary = param(part.headers.get("content-type") ?? "", "boundary");
  if (type.startsWith("multipart/") && boundary !== undefined) {
    const sections = part.body.split(`--${boundary}`).slice(1);
    for (const section of sections) {
      if (section.startsWith("--")) break;
      collectParts(splitHead(section.replace(/^\n/u, "")), out);
    }
    return;
  }
  if (type.startsWith("text/html")) out.html ??= decodeBody(part);
  else if (type.startsWith("text/plain")) out.text ??= decodeBody(part);
}

export function parseEml(raw: string, timeZone?: string): EmailInput {
  const root = splitHead(raw);
  const body: { text?: string; html?: string } = {};
  collectParts(root, body);
  const dateHeader = root.headers.get("date");
  return {
    from: decodeWords(root.headers.get("from") ?? ""),
    subject: decodeWords(root.headers.get("subject") ?? ""),
    ...(body.text === undefined ? {} : { text: body.text }),
    ...(body.html === undefined ? {} : { html: body.html }),
    ...(dateHeader === undefined ? {} : { date: new Date(dateHeader) }),
    ...(timeZone === undefined ? {} : { timeZone }),
  };
}
