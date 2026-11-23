/*
 * The regex subset every data file must stay within. Its meaning is that of JavaScript with the
 * u flag; ports translate what their engine reads differently (the Python loader spells out
 * \d \w \s \b, `.`, `^`/`$` and case-insensitive i). Go RE2's \s is ASCII only, so a Go port
 * must spell classes out the same way.
 */

const ALLOWED_ESCAPES = new Set(Array.from("dDwWsSbBnrtfv.\\/^$*+?()[]{}|-"));
const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

interface Scan {
  readonly pattern: string;
  readonly problems: string[];
  index: number;
  inClass: boolean;
}

function checkEscape(scan: Scan): void {
  const next = scan.pattern[scan.index + 1] ?? "";
  if (/[1-9]/u.test(next) || next === "k") scan.problems.push("backreference");
  else if (next === "A" || next === "Z" || next === "z" || next === "G")
    scan.problems.push(`\\${next} anchor`);
  else if (next === "x") {
    if (!/^[0-9A-Fa-f]{2}$/u.test(scan.pattern.slice(scan.index + 2, scan.index + 4)))
      scan.problems.push("\\x needs two hex digits");
  } else if (next === "-" && !scan.inClass) scan.problems.push("\\- outside a character class");
  else if (next === "b" && scan.inClass) scan.problems.push("\\b inside a character class");
  else if (!ALLOWED_ESCAPES.has(next)) scan.problems.push(`unsupported escape \\${next}`);
  scan.index += 2;
}

function checkGroupOpen(scan: Scan): void {
  const rest = scan.pattern.slice(scan.index);
  if (!rest.startsWith("(?")) return;
  if (/^\(\?<?[=!]/u.test(rest)) scan.problems.push("lookaround");
  else if (rest.startsWith("(?>")) scan.problems.push("atomic group");
  else if (rest.startsWith("(?P")) scan.problems.push("(?P...) group syntax; write (?<name>...)");
  else if (rest.startsWith("(?<")) {
    const name = /^\(\?<([^>]*)>/u.exec(rest)?.[1] ?? "";
    if (!GROUP_NAME.test(name)) scan.problems.push(`invalid group name "${name}"`);
  } else if (!rest.startsWith("(?:")) scan.problems.push("inline flags or unknown group syntax");
}

function checkQuantifier(scan: Scan): void {
  const char = scan.pattern[scan.index] ?? "";
  if (char === "{") {
    const brace = /^\{(\d*)(,?)(\d*)\}/u.exec(scan.pattern.slice(scan.index));
    if (brace !== null && brace[1] === "") scan.problems.push("{,n} quantifier");
    return;
  }
  if ((char === "*" || char === "+" || char === "?" || char === "}") && !scan.inClass) {
    const next = scan.pattern[scan.index + 1];
    const prev = scan.pattern[scan.index - 1];
    // "a++" is possessive; "(?" was handled as a group, and "+?" is a lazy quantifier.
    if (next === "+" && prev !== "(") scan.problems.push("possessive quantifier");
  }
}

/** Returns why `pattern` is outside the portable subset; empty when it is portable. */
export function portabilityProblems(pattern: string): string[] {
  const scan: Scan = { pattern, problems: [], index: 0, inClass: false };
  // Case folding of dotless ı and dotted İ differs between engines; keep them out of patterns.
  if (/[\u0130\u0131]/u.test(pattern)) scan.problems.push("dotless ı or dotted İ");
  while (scan.index < pattern.length) {
    const char = pattern[scan.index];
    if (char === "\\") {
      checkEscape(scan);
      continue;
    }
    if (scan.inClass) {
      if (char === "]") scan.inClass = false;
    } else if (char === "[") {
      scan.inClass = true;
      if (pattern[scan.index + 1] === "]") scan.index += 1;
    } else if (char === "(") {
      checkGroupOpen(scan);
    } else {
      checkQuantifier(scan);
    }
    scan.index += 1;
  }
  return [...new Set(scan.problems)];
}

/** Compiles a data regex the way the engine does, with the u flag plus its own flags. */
export function compileDataRegex(pattern: string, flags: readonly string[] = []): RegExp {
  return new RegExp(pattern, `u${flags.join("")}`);
}
