"""Reference loader for the open-parcels-rules bundle, standard library only.

Reads dist/bundle.json (as built by `npm run build`) and offers tracking-number validation and
detection plus status mapping. It is a small port that proves the data is language neutral;
the TypeScript engine stays the complete implementation (arrival dates and mail rules are not
ported here).

Data regexes use `(?<name>...)` for named groups, which Python spells `(?P<name>...)`; the
loader rewrites that one construct and otherwise compiles the patterns as they are.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

__all__ = [
    "Rules",
    "load_rules",
    "validate_tracking_number",
    "detect_tracking_numbers",
    "map_status",
    "ignored_status",
]

DEFAULT_BUNDLE = Path(__file__).resolve().parents[2] / "dist" / "bundle.json"
_NAMED_GROUP = re.compile(r"\(\?<(?=[A-Za-z_])")
_BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


# What the TypeScript engine's `u`-flag regexes mean by each class escape. Python's defaults are
# Unicode-wide (\d matches Arabic-Indic digits, \w accented letters), and re.ASCII narrows \s to
# ASCII whitespace while JavaScript's \s also covers NBSP and the other Unicode spaces. Spelling
# the classes out gives both engines one meaning whatever the flags.
_JS_SPACE = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
_WORD = "A-Za-z0-9_"
_IN_CLASS = {"d": "0-9", "w": _WORD, "s": _JS_SPACE}
_OUTSIDE = {
    "d": "[0-9]",
    "D": "[^0-9]",
    "w": f"[{_WORD}]",
    "W": f"[^{_WORD}]",
    "s": f"[{_JS_SPACE}]",
    "S": f"[^{_JS_SPACE}]",
    "b": f"(?:(?<=[{_WORD}])(?![{_WORD}])|(?<![{_WORD}])(?=[{_WORD}]))",
    "B": f"(?:(?<=[{_WORD}])(?=[{_WORD}])|(?<![{_WORD}])(?![{_WORD}]))",
}


# JavaScript (u flag) reads `.` as "not a line terminator", `$` as the very end (or, with m, before
# any line terminator) and `^` with m as after any of them; Python only knows \n and lets `$`
# match before a trailing \n. Spelled out, both engines agree.
_LINE_ENDS = "\\n\\r\\u2028\\u2029"
# With the i flag Python folds dotless ı and dotted İ onto i/I (and [a-z], \w); JavaScript's
# `iu` does not. The check is case-sensitive (?-i:...), or it would itself fold onto i.
_TURKISH_I = "(?-i:[\\u0131\\u0130])"


def _atom(cls: str, ignore_case: bool) -> str:
    """A class (or i/I literal) that, with the i flag, means what JavaScript means."""
    if not ignore_case:
        return cls
    if cls.startswith("[^"):
        return f"(?:{_TURKISH_I}|{cls})"
    return f"(?:(?!{_TURKISH_I}){cls})"


def _word_boundary(escape: str, ignore_case: bool) -> str:
    word = _atom(f"[{_WORD}]", ignore_case)
    if escape == "b":
        return f"(?:(?<={word})(?!{word})|(?<!{word})(?={word}))"
    return f"(?:(?<={word})(?={word})|(?<!{word})(?!{word}))"


def _read_class(pattern: str, index: int) -> tuple[str, int]:
    """The class starting at pattern[index] == "[" with its escapes spelled out, and the index after it."""
    out = ["["]
    index += 1
    if pattern[index : index + 1] == "^":
        out.append("^")
        index += 1
    if pattern[index : index + 1] == "]":
        out.append("]")
        index += 1
    while index < len(pattern):
        char = pattern[index]
        if char == "\\" and index + 1 < len(pattern):
            escape = pattern[index + 1]
            # \D, \W and \S inside a class are outside the portable subset's use; kept as is.
            out.append(_IN_CLASS.get(escape, pattern[index : index + 2]))
            index += 2
            continue
        out.append(char)
        index += 1
        if char == "]":
            break
    return "".join(out), index


def _group_open(pattern: str, index: int) -> int:
    """Length of the group syntax at pattern[index] ("(?:", "(?P<name>", "(?<=", ...)."""
    rest = pattern[index:]
    if rest.startswith("(?P<"):
        return rest.index(">") + 1
    for opener in ("(?<=", "(?<!", "(?:", "(?=", "(?!"):
        if rest.startswith(opener):
            return len(opener)
    return 1


def _translate(pattern: str, flags: list[str]) -> str:
    ignore_case = "i" in flags
    multiline = "m" in flags
    out: list[str] = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "\\" and index + 1 < len(pattern):
            escape = pattern[index + 1]
            if escape in ("b", "B"):
                out.append(_word_boundary(escape, ignore_case))
            elif escape in _OUTSIDE:
                out.append(_atom(_OUTSIDE[escape], ignore_case))
            else:
                out.append(pattern[index : index + 2])
            index += 2
            continue
        if char == "[":
            cls, index = _read_class(pattern, index)
            out.append(_atom(cls, ignore_case))
            continue
        if char == "(":
            length = _group_open(pattern, index)
            out.append(pattern[index : index + length])
            index += length
            continue
        if char == "." and "s" not in flags:
            out.append(f"[^{_LINE_ENDS}]")
        elif char == "$":
            out.append(f"(?=[{_LINE_ENDS}]|\\Z)" if multiline else "\\Z")
        elif char == "^" and multiline:
            out.append(f"(?<![^{_LINE_ENDS}])")
        elif char in "iI" and ignore_case:
            out.append(_atom(char, ignore_case))
        else:
            out.append(char)
        index += 1
    return "".join(out)


def to_python_regex(pattern: str, flags: list[str] | None = None) -> str:
    """Rewrites a portable pattern (with its data flags) for Python's re so it means what the
    TypeScript engine's `u`-flag regex means: named groups, class escapes, `.`, `^`, `$`, and
    case-insensitive dotless/dotted i."""
    return _translate(_NAMED_GROUP.sub("(?P<", pattern), flags or [])


def _flags(names: list[str] | None) -> int:
    """re flags for a data pattern. re.ASCII unless case is ignored: JavaScript's `iu` folds
    non-ASCII letters (Ä/ä), and so must Python, which re.ASCII would stop."""
    table = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}
    result = 0
    for name in names or []:
        result |= table[name]
    return result if result & re.IGNORECASE else result | re.ASCII


def _digit(char: str) -> int:
    return int(char) if char.isdigit() else (ord(char) - 3) % 10


def _mod10(spec: dict[str, Any], serial: str, check: str) -> bool:
    chars = serial[::-1] if spec.get("reverse") else serial
    total = 0
    for index, char in enumerate(chars):
        value = _digit(char)
        if spec.get("odds_multiplier") is not None and index % 2 == 1:
            value *= spec["odds_multiplier"]
        elif spec.get("evens_multiplier") is not None and index % 2 == 0:
            value *= spec["evens_multiplier"]
        total += value
    modulo = spec.get("modulo", 10)
    return str((modulo - total % modulo) % modulo) == check


def _mod7(spec: dict[str, Any], serial: str, check: str) -> bool:
    return str(int(serial) % spec.get("modulo", 7)) == check


def _s10(spec: dict[str, Any], serial: str, check: str) -> bool:
    weights = spec.get("weightings", [8, 6, 4, 2, 3, 5, 9, 7])
    modulo = spec.get("modulo", 11)
    remainder = sum(_digit(c) * w for c, w in zip(serial, weights)) % modulo
    expected = 5 if remainder == 0 else 0 if remainder == 1 else modulo - remainder
    return str(expected) == check


def _luhn(_spec: dict[str, Any], serial: str, check: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(serial)):
        value = _digit(char)
        if index % 2 == 0:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return str((10 - total % 10) % 10) == check


def _mod_37_36(spec: dict[str, Any], serial: str, check: str) -> bool:
    alphabet = spec.get("alphabet", _BASE36)
    modulo = spec.get("modulo", 36)
    product = modulo
    for char in serial:
        value = alphabet.find(char)
        if value < 0:
            return False
        total = (product + value) % modulo or modulo
        product = (total * 2) % (modulo + 1)
    return alphabet[(modulo + 1 - product) % modulo] == check


def _sum_product(spec: dict[str, Any], serial: str, check: str) -> bool:
    total = sum(_digit(c) * w for c, w in zip(serial, spec["weightings"]))
    return str(total % spec["modulo1"] % spec["modulo2"]) == check


_CHECKSUMS = {
    "mod10": _mod10,
    "mod7": _mod7,
    "s10": _s10,
    "luhn": _luhn,
    "mod_37_36": _mod_37_36,
    "sum_product_with_weightings_and_modulo": _sum_product,
}


@dataclass
class TrackingType:
    courier_code: str
    id: str
    name: str
    spec: dict[str, Any]
    exact: re.Pattern[str]
    search: re.Pattern[str]


@dataclass
class Rules:
    version: str
    types: list[TrackingType]
    courier_carriers: dict[str, str]
    upu_carriers: dict[str, str]
    carrier_names: dict[str, str]
    status: dict[str, dict[str, Any]] = field(default_factory=dict)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _normalize_name(name: str) -> str:
    """As the TypeScript engine does: NFKD, accents dropped, lower case, letters and digits only."""
    decomposed = unicodedata.normalize("NFKD", name)
    bare = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"[\W_]+", "", bare.lower())


# JavaScript's whitespace, for trimming and removing spaces the way the TypeScript engine does:
# Python's own str.strip() and \s leave U+FEFF in place and treat other characters as space.
_JS_WHITESPACE = re.compile(f"[{_JS_SPACE}]+")
_JS_EDGES = re.compile(f"^[{_JS_SPACE}]+|[{_JS_SPACE}]+$")
_JS_LEADING = re.compile(f"^[{_JS_SPACE}]+")
_JS_TRAILING = re.compile(f"[{_JS_SPACE}]+$")


def _trim(value: str) -> str:
    return _JS_EDGES.sub("", value)


def _no_spaces(value: str) -> str:
    return _JS_WHITESPACE.sub("", value)


def _without_edge_spaces(pattern: str) -> str:
    """The pattern without leading and trailing \\s*, as the TypeScript engine scans with: the
    optional edges change no match, and a leading \\s* backtracked through whitespace runs."""
    result = pattern
    while result.startswith("\\s*") and result[3:4] not in ("?", "+", "{"):
        result = result[3:]
    while result.endswith("\\s*") and not result.endswith("\\\\s*"):
        result = result[:-3]
    return result


# Longest line scanned in one piece, as in the TypeScript engine.
MAX_LINE = 4096


def scan_lines(text: str) -> list[str]:
    """Lines split only at \\n and \\r\\n, whitespace runs collapsed to one space and overlong
    lines cut at a space before MAX_LINE, exactly as the TypeScript engine's scanLines."""
    pieces: list[str] = []
    for raw in re.split(r"\r?\n", text):
        line = _JS_WHITESPACE.sub(" ", raw)
        while len(line) > MAX_LINE:
            space = line.rfind(" ", 0, MAX_LINE + 1)
            cut = space if space > 0 else MAX_LINE
            pieces.append(line[:cut])
            line = line[cut:]
        pieces.append(line)
    return pieces


def load_rules(path: str | Path = DEFAULT_BUNDLE) -> Rules:
    bundle = json.loads(Path(path).read_text(encoding="utf-8"))
    types = []
    for source in bundle["tracking"]:
        courier = source["courier"]
        for spec in courier["tracking_numbers"]:
            raw = spec["regex"]
            joined = "".join(raw) if isinstance(raw, list) else raw
            pattern = to_python_regex(joined)
            scan = to_python_regex(_without_edge_spaces(joined))
            types.append(
                TrackingType(
                    courier_code=courier["courier_code"],
                    id=spec.get("id") or f"{courier['courier_code']}_{_slug(spec['name'])}",
                    name=spec["name"],
                    spec=spec,
                    exact=re.compile(f"(?:{pattern})", re.ASCII),
                    search=re.compile(f"(?<![A-Za-z0-9])(?:{scan})(?![A-Za-z0-9])", re.ASCII),
                )
            )
    courier_carriers: dict[str, str] = {}
    upu_carriers: dict[str, str] = {}
    carrier_names: dict[str, str] = {}
    for carrier in bundle["carriers"]:
        for code in [carrier["id"], *carrier.get("courier_codes", [])]:
            courier_carriers[code] = carrier["id"]
        for country in carrier.get("upu_countries", []):
            upu_carriers[country] = carrier["id"]
        for name in [carrier["id"], carrier["name"], *carrier.get("aliases", [])]:
            carrier_names.setdefault(_normalize_name(name), carrier["id"])
    status = {
        table["carrier"]: {
            "entries": _compile_matcher(table["entries"]),
            "ignore": _compile_matcher(table.get("ignore", [])),
        }
        for table in bundle["status"]
    }
    return Rules(bundle["version"], types, courier_carriers, upu_carriers, carrier_names, status)


def _compile_matcher(entries: list[dict[str, Any]]) -> dict[str, Any]:
    codes: dict[str, dict[str, Any]] = {}
    prefixes = []
    fields = []
    texts = []
    for entry in entries:
        match = entry["match"]
        if "code" in match:
            codes.setdefault(_trim(match["code"]), entry)
        elif "code_prefix" in match:
            prefixes.append((_trim(match["code_prefix"]).upper(), entry))
        elif "text" in match:
            regex = re.compile(to_python_regex(match["text"], match.get("flags")), _flags(match.get("flags")))
            texts.append((regex, _field_pairs(match.get("fields")), entry))
        else:
            fields.append((_field_pairs(match["fields"]), entry))
    return {"codes": codes, "prefixes": prefixes, "fields": fields, "texts": texts}


def _field_pairs(fields: dict[str, str] | None) -> dict[str, str]:
    return {k: _trim(v) for k, v in (fields or {}).items()}


def _fields_hold(wanted: dict[str, str], given: dict[str, str | None] | None) -> bool:
    """Every wanted field is given, as a string, with the same trimmed value; None never holds."""
    if given is None:
        return not wanted
    return all(isinstance(given.get(name), str) and _trim(given[name] or "") == value for name, value in wanted.items())


def _find_entry(
    matcher: dict[str, Any], code: str | None, text: str | None, fields: dict[str, str] | None
) -> dict[str, Any] | None:
    """Field entries, then the exact code (as written, then ignoring case), prefixes, texts."""
    if fields is not None:
        for wanted, entry in matcher["fields"]:
            if _fields_hold(wanted, fields):
                return entry
    if code and _trim(code):
        stripped = _trim(code)
        folded = stripped.upper()
        entry = (
            matcher["codes"].get(stripped)
            or next((e for c, e in matcher["codes"].items() if c.upper() == folded), None)
            or next((e for prefix, e in matcher["prefixes"] if folded.startswith(prefix)), None)
        )
        if entry is not None:
            return entry
    if text and _trim(text):
        return next(
            (e for regex, wanted, e in matcher["texts"] if regex.search(_trim(text)) and _fields_hold(wanted, fields)),
            None,
        )
    return None


def _strip(value: str | None) -> str | None:
    return None if value is None else _no_spaces(value)


def _check_type(kind: TrackingType, number: str) -> dict[str, Any] | None:
    match = kind.exact.fullmatch(number)
    if match is None:
        return None
    groups = {name: _strip(value) for name, value in match.groupdict().items() if value is not None}
    validation = kind.spec.get("validation", {})
    checksum = validation.get("checksum")
    checksum_valid = None
    if checksum is not None:
        serial, check = groups.get("SerialNumber"), groups.get("CheckDigit")
        prepend = validation.get("serial_number_format", {}).get("prepend_if")
        if serial is not None and prepend and re.search(to_python_regex(prepend["matches_regex"]), serial, re.ASCII):
            serial = prepend["content"] + serial
        checksum_valid = (
            serial is not None and check is not None and _CHECKSUMS[checksum["name"]](checksum, serial, check)
        )
    lookups_ok = True
    for name in validation.get("additional", {}).get("exists", []):
        additional = next((a for a in kind.spec.get("additional", []) if a["name"] == name), None)
        value = groups.get(additional["regex_group_name"]) if additional else None
        lookups_ok = lookups_ok and value is not None and any(
            row.get("matches") == value
            or (row.get("matches_regex") and re.fullmatch(to_python_regex(row["matches_regex"]), value, re.ASCII))
            for row in additional["lookup"]
        )
    return {
        "type": kind.id,
        "groups": groups,
        "checksum_valid": checksum_valid,
        "valid": checksum_valid is not False and lookups_ok,
    }


def _carrier(rules: Rules, kind: TrackingType, groups: dict[str, str]) -> str:
    if kind.courier_code == "s10":
        return rules.upu_carriers.get(groups.get("CountryCode", ""), "upu")
    return rules.courier_carriers.get(kind.courier_code, kind.courier_code)


def validate_tracking_number(rules: Rules, number: str, type_id: str) -> dict[str, Any] | None:
    """Checks one number against one format; None when the format does not fit at all."""
    normalized = _no_spaces(number).upper()
    kind = next(t for t in rules.types if t.id == type_id)
    return _check_type(kind, normalized)


@dataclass
class _Hit:
    kind: TrackingType
    number: str
    result: dict[str, Any]
    line: int
    start: int
    end: int


def _scan_line(rules: Rules, line: str, index: int) -> list[_Hit]:
    hits = []
    for kind in rules.types:
        for match in kind.search.finditer(line):
            raw = match.group(0)
            if not raw:
                continue
            result = _check_type(kind, _no_spaces(raw).upper())
            if result is None:
                continue
            # The span without surrounding spaces, as the TypeScript engine measures it.
            start = match.start() + len(raw) - len(_JS_LEADING.sub("", raw))
            end = match.start() + len(_JS_TRAILING.sub("", raw))
            hits.append(_Hit(kind, _no_spaces(raw).upper(), result, index, start, end))
    return hits


def _drop_contained(hits: list[_Hit]) -> list[_Hit]:
    """Drops hits lying inside a longer valid hit on the same line (14 digits inside 20).
    Sorted by start and swept per line, as the TypeScript engine does."""
    by_line: dict[int, list[_Hit]] = {}
    for hit in hits:
        by_line.setdefault(hit.line, []).append(hit)
    dropped: set[int] = set()
    for line in by_line.values():
        ordered = sorted(line, key=lambda hit: hit.start)
        end_before = -1
        index = 0
        while index < len(ordered):
            start = ordered[index].start
            group = []
            while index < len(ordered) and ordered[index].start == start:
                group.append(ordered[index])
                index += 1
            end_here = max([-1, *(hit.end for hit in group if hit.result["valid"])])
            dropped.update(id(hit) for hit in group if end_before >= hit.end or end_here > hit.end)
            end_before = max(end_before, end_here)
    return [hit for hit in hits if id(hit) not in dropped]


def detect_tracking_numbers(rules: Rules, text: str) -> list[dict[str, Any]]:
    """Every valid number in the text with its carrier and format ids (no confidence model)."""
    found: dict[tuple[str, str], dict[str, Any]] = {}
    hits = [hit for index, line in enumerate(scan_lines(text)) for hit in _scan_line(rules, line, index)]
    for hit in _drop_contained(hits):
        if not hit.result["valid"]:
            continue
        carrier = _carrier(rules, hit.kind, hit.result["groups"])
        entry = found.setdefault(
            (carrier, hit.number),
            {"carrier": carrier, "tracking_number": hit.number, "types": [], "checksum_valid": None},
        )
        entry["types"].append(hit.kind.id)
        if entry["checksum_valid"] is not True:
            entry["checksum_valid"] = hit.result["checksum_valid"]
    return list(found.values())


def map_status(
    rules: Rules,
    carrier: str,
    code: str | None = None,
    text: str | None = None,
    fields: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """A carrier's raw status code, text or named fields as {status, pickup?, confirmed}, or None."""
    table = _table(rules, carrier)
    entry = None if table is None else _find_entry(table["entries"], code, text, fields)
    if entry is None:
        return None
    result = {"status": entry["status"], "confirmed": entry.get("confirmed", True)}
    if entry.get("pickup"):
        result["pickup"] = True
    for name in ("stage", "label"):
        if name in entry:
            result[name] = entry[name]
    return result


def ignored_status(
    rules: Rules,
    carrier: str,
    code: str | None = None,
    text: str | None = None,
    fields: dict[str, str] | None = None,
) -> str | None:
    """The event an `ignore` entry gives a raw value (e.g. order_cancelled), or None."""
    table = _table(rules, carrier)
    entry = None if table is None else _find_entry(table["ignore"], code, text, fields)
    return None if entry is None else entry["event"]


def _table(rules: Rules, carrier: str) -> dict[str, Any] | None:
    return rules.status.get(rules.carrier_names.get(_normalize_name(carrier), carrier))
