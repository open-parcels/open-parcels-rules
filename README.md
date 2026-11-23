<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/open-parcels/open-parcels/master/docs/branding/banner-on-dark.png">
    <img alt="Open Parcels" src="https://raw.githubusercontent.com/open-parcels/open-parcels/master/docs/branding/banner-on-light.png" width="640">
  </picture>
</p>
<p align="center">
  <a href="https://github.com/open-parcels/open-parcels-rules/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/open-parcels/open-parcels-rules?include_prereleases&sort=semver"></a>
  <a href="https://github.com/open-parcels/open-parcels-rules/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/open-parcels/open-parcels-rules?style=flat"></a>
  <a href="https://github.com/open-parcels/open-parcels-rules/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/open-parcels/open-parcels-rules"></a>
  <a href="https://github.com/open-parcels/open-parcels-rules/commits"><img alt="Last commit" src="https://img.shields.io/github/last-commit/open-parcels/open-parcels-rules"></a>
</p>

# open-parcels-rules

Collectively maintained knowledge about parcel tracking, written as plain data, plus a small
TypeScript engine that reads it:

- **Tracking-number formats**: which carrier a number belongs to, with check digits.
- **Carrier status tables**: raw carrier codes and texts mapped onto eight canonical states.
- **Delivery-date phrases**: "Arriving 3 - 5 December", "Zustellung heute 17h - 19h" and the
  like turned into a time window in the right time zone.
- **Shipping-mail rules**: which sender says what, and where the tracking number, order
  number, arrival date and pickup code are.

The data is language neutral (YAML and JSON with JSON Schemas, and a regex subset that compiles
the same in JavaScript, Python and Go), so other projects can read it too. A stdlib-only Python
loader in [`python/`](python/) proves that.

## Contents

| Path | What it holds |
| --- | --- |
| [`data/carriers.yaml`](data/carriers.yaml) | Carrier registry: id, name, aliases, countries, mail domains, tracking URL templates per locale, tracking-number shape, cross-reference ids |
| [`data/keys.yaml`](data/keys.yaml) | Fixed public values carriers expect from every client (website and app keys, client ids, app versions, User-Agents), with purpose, source and last-verified date |
| [`data/tracking-numbers/`](data/tracking-numbers/) | Our tracking-number formats, in the same schema as the vendored community files |
| [`vendor/tracking_number_data/`](vendor/tracking_number_data/) | Pinned, unmodified copy of the community tracking_number_data courier files (MIT, see its `LICENSE` and `VERSION`) |
| [`data/status/`](data/status/) | Status tables per carrier, with test vectors |
| [`data/locales/`](data/locales/) | Delivery-date words and phrases per language, with test vectors |
| [`data/mail/`](data/mail/) | One YAML file per mail rule, each tested against made-up `.eml` fixtures in [`test/fixtures/mail/`](test/fixtures/mail/) |
| [`schema/`](schema/) | JSON Schema (2020-12) for every data file type, generated from the TypeScript schemas |
| [`src/`](src/) | The TypeScript engine |
| [`python/`](python/) | Python reference loader and vector runner |
| [`docs/`](docs/) | Data formats, how to contribute, how to consume the package |

## Canonical statuses

`registered`, `in_transit`, `out_for_delivery`, `at_pickup_point`, `delivered`, `returning`,
`problem`, `unknown`. A parcel waiting to be collected is `at_pickup_point`; one still on its
way to a pickup point is `in_transit` with `pickup: true`. `problem` covers exceptions, failed
attempts, holds, damage and address issues; `returning` means on its way back to the sender.

## Using it from TypeScript

```ts
import { loadRules, detectTrackingNumbers, mapStatus, parseArrival, parseMail } from "open-parcels-rules";

const rules = loadRules(); // reads and validates dist/bundle.json once

detectTrackingNumbers(rules, "Sendungsnummer 00340434123456789012", { country: "DE" });
// [{ carrier: "dhl", trackingNumber: "00340434123456789012", confidence: 0.73, checksumValid: true, ... }, ...]

mapStatus(rules, "hermes", { code: "ZUGESTELLT_PAKETSHOP" });
// { status: "at_pickup_point", pickup: true, confirmed: true }

parseArrival(rules, "Zustellung heute 17h - 19h", { now: new Date(), timeZone: "Europe/Berlin" });
// { from: "...T17:00:00+01:00", to: "...T19:00:00+01:00", allDay: false, matched: "Zustellung heute 17h - 19h" }

parseMail(rules, { from: "noreply@dhl.de", subject: "Ihr DHL Paket kommt heute", text, date });
```

The full API, with every option, is in [`docs/consuming.md`](docs/consuming.md). Mail results
can carry a `pickupCode`: show it to the recipient, but never write it to logs.

## Using it from Python

```sh
npm run build                          # produces dist/bundle.json
python -I python/run_vectors.py        # runs the shared test vectors
```

```python
from open_parcels_rules import load_rules, detect_tracking_numbers, map_status

rules = load_rules("dist/bundle.json")
detect_tracking_numbers(rules, "RR987654326GB")
map_status(rules, "gls", code="DELIVEREDPS")
```

## Contributing a rule

Every rule comes with test vectors, and the gate fails without them. In short:

1. Edit or add the data file (the `# yaml-language-server: $schema=...` header gives editor
   completion).
2. Add vectors: `test_numbers` for formats, `tests` for statuses and locales, and an `.eml`
   fixture with its expected result for mail rules. Use made-up values only; numbers must
   still pass their check digits.
3. Run `npm run gate`.

Details for each data type are in [`docs/contributing.md`](docs/contributing.md).

### The regex subset

Every regex in our data files must mean the same in every engine port. The meaning is that of
JavaScript with the `u` flag; ports translate where their engine differs (the Python loader
spells out `\d \w \s \b`, `.` and `^`/`$` as JavaScript reads them, and keeps `i` from folding
`ı`/`İ` onto `i`; Go RE2's `\s` is ASCII only, so a Go port must do the same).
[`test/fixtures/regex-vectors.json`](test/fixtures/regex-vectors.json) runs in both engines. A
test enforces the subset:

- no lookahead or lookbehind, no backreferences, no atomic groups, no possessive quantifiers;
- no `\A`, `\Z` or `\z` (use `^` and `$`), no `\u` escapes (write the character), no `{,n}`;
- named groups as `(?<name>...)` (Python ports rewrite them to `(?P<name>...)`);
- case-insensitivity through a `flags: [i]` field, never inline `(?i)`.
- no dotless `ı` or dotted `İ` (engines fold them differently).

The vendored upstream files keep their own patterns; the ones outside the subset are listed in
[`vendor/tracking_number_data/PORTABILITY.md`](vendor/tracking_number_data/PORTABILITY.md).

## Development

Node 26 and npm 11. `npm install`, then `npm run gate` (format check, lint, type check, build,
tests, Python vectors). `npm run generate` refreshes the JSON Schemas and the portability report
after a schema change.

## Licence

Released into the public domain under [the Unlicense](LICENSE). The vendored community data in
`vendor/tracking_number_data/` keeps its own MIT licence.
