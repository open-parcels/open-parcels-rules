"""Runs the shared test vectors (dist/vectors.json) against the Python reference loader.

Usage: python -I python/run_vectors.py [dist-dir]
Exits non-zero on the first mismatch report.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from open_parcels_rules import (  # noqa: E402
    _flags,
    _normalize_name,
    detect_tracking_numbers,
    ignored_status,
    load_rules,
    map_status,
    to_python_regex,
    validate_tracking_number,
)


def main() -> int:
    dist = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "dist"
    rules = load_rules(dist / "bundle.json")
    vectors = json.loads((dist / "vectors.json").read_text(encoding="utf-8"))
    failures: list[str] = []
    checked = 0
    # An empty section would pass silently; every one of them must hold vectors.
    sections = {**vectors, **{f"parity.{k}": v for k, v in vectors.get("parity", {}).items()}}
    for name in ("tracking", "status", "regex", "parity.names", "parity.detect", "parity.status"):
        if not sections.get(name):
            failures.append(f"{name}: no vectors in the bundle")

    ids = {}
    for kind in rules.types:
        ids.setdefault(kind.name, kind.id)
    for vector in vectors["tracking"]:
        type_id = vector["id"] or ids[vector["name"]]
        for number in vector["valid"]:
            checked += 1
            result = validate_tracking_number(rules, number, type_id)
            if result is None or not result["valid"]:
                failures.append(f"{type_id}: {number!r} should be valid")
        for number in vector["invalid"]:
            checked += 1
            result = validate_tracking_number(rules, number, type_id)
            if result is not None and result["valid"]:
                failures.append(f"{type_id}: {number!r} should be invalid")

    for table in vectors["status"]:
        for test in table["tests"]:
            checked += 1
            raw = test["input"]
            mapped = map_status(rules, table["carrier"], raw.get("code"), raw.get("text"), raw.get("fields"))
            status = None if mapped is None else mapped["status"]
            if status != test["status"]:
                failures.append(f"status/{table['carrier']}: {raw} gave {status}, expected {test['status']}")
            elif "pickup" in test and bool(mapped and mapped.get("pickup")) != test["pickup"]:
                failures.append(f"status/{table['carrier']}: {raw} pickup flag differs")
            elif "stage" in test and (mapped or {}).get("stage") != test["stage"]:
                failures.append(f"status/{table['carrier']}: {raw} stage differs")
            elif "label" in test and (mapped or {}).get("label") != test["label"]:
                failures.append(f"status/{table['carrier']}: {raw} label differs")
            elif "ignored" in test:
                ignored = ignored_status(rules, table["carrier"], raw.get("code"), raw.get("text"), raw.get("fields"))
                if ignored != test["ignored"]:
                    failures.append(f"status/{table['carrier']}: {raw} ignored as {ignored}, expected {test['ignored']}")

    for case in vectors.get("regex", []):
        checked += 1
        regex = re.compile(to_python_regex(case["pattern"], case.get("flags")), _flags(case.get("flags")))
        if (regex.search(case["input"]) is not None) != case["matches"]:
            failures.append(f"regex: {case['pattern']!r} on {case['input']!r} should match: {case['matches']}")

    parity = vectors.get("parity", {})
    for case in parity.get("names", []):
        checked += 1
        found = rules.carrier_names.get(_normalize_name(case["name"]))
        if found != case["carrier"]:
            failures.append(f"names: {case['name']!r} gave {found}, expected {case['carrier']}")
    for case in parity.get("detect", []):
        checked += 1
        numbers = sorted({hit["tracking_number"] for hit in detect_tracking_numbers(rules, case["text"])})
        if numbers != case["numbers"]:
            failures.append(f"detect: {case['text']!r} gave {numbers}, expected {case['numbers']}")
    for case in parity.get("status", []):
        checked += 1
        raw = case["input"]
        mapped = map_status(rules, case["carrier"], raw.get("code"), raw.get("text"), raw.get("fields"))
        status = None if mapped is None else mapped["status"]
        if status != case["status"]:
            failures.append(f"parity status/{case['carrier']}: {raw} gave {status}, expected {case['status']}")

    for failure in failures:
        print(f"FAIL {failure}")
    print(f"{checked - len(failures)}/{checked} vectors passed (bundle {rules.version})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
