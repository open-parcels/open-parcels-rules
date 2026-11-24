# Contributing

Everything in `data/` is meant to be edited by people who know a carrier, a shop or a
language, without touching TypeScript. Each change needs test vectors; `npm run gate` runs
them all, and nothing merges without a green gate.

## Ground rules

- **Made-up values only.** No real tracking numbers, order numbers, names, addresses or email
  addresses in data or fixtures. Numbers must still be valid: compute their check digits (the
  engine's `verifyChecksum` in `src/tracking/checksums.ts` does it), never copy one from a
  real parcel.
- **Portable regexes** (see the README): the gate rejects lookarounds, backreferences, inline
  flags and the rest.
- **Say how sure you are.** Status entries you have not seen in real data get
  `confirmed: false`; formats whose check digit is unknown get no checksum and a description
  saying so.
- **Sentence case, English** in names, descriptions and comments.

## Adding a tracking-number format

1. Add an entry to `data/tracking-numbers/<carrier>.json` (create the file with `name`,
   `courier_code` and `tracking_numbers` if needed; the carrier must exist in
   `data/carriers.yaml`).
2. Give it an `id`, a whitespace-tolerant `regex` with `SerialNumber` and, if there is one,
   `CheckDigit`, the `validation.checksum`, and `test_numbers` with at least two valid and two
   invalid numbers (a wrong check digit, a wrong length).
3. Think about collisions: many formats are "n digits". `detectTrackingNumbers` returns every
   candidate; hints (sender domain, carrier name, country) decide, so make sure the carrier's
   `domains` and `aliases` are complete.

## Adding or fixing a status

Add entries to `data/status/<carrier>.yaml` and a vector for each. Order matters for text
entries: put the specific phrase first ("nicht zugestellt" before "zugestellt",
"niedoręczona" before "doręczona"). Watch for words that look like delivered but are not:
"delivered to the parcel shop" is `at_pickup_point`, "returned to sender ... delivered" is
`returning`, and "abgeholt"/"picked up" often means the courier collected it from the sender.

## Adding a language

Copy `data/locales/en.yaml` to `data/locales/<lang>.yaml` (ISO 639-1 code) and translate the
word lists. Leave out short words that are also ordinary words (German "so", "do"). Add
vectors for whole days, ranges, time windows, and texts that must not parse. Test around a
daylight-saving change in a zone that has one.

## Adding an email rule

1. Write the rule as `data/mail/<kind>-<sender>.yaml` (see [mail-rules.md](mail-rules.md)).
2. Write one or more fixtures in `test/fixtures/mail/` and list them under `tests` with the
   expected results. Include every result the email produces, from all rules, in rule-id order.
3. Prefer `detect_tracking_numbers` over a loose digit regex; prefer `require` over rules
   that produce empty results.

## Updating the vendored formats

1. Shallow-clone the upstream repository at a release tag into a temporary directory. Do not
   run its code.
2. Copy `couriers/*.json` and `LICENSE` into `vendor/tracking_number_data/` unchanged, and
   update `VERSION` (tag, commit, date).
3. `npm run generate` refreshes `PORTABILITY.md`; `npm run gate` runs every upstream test
   number.

## Schema changes

Edit the zod schema in `src/schema/`, run `npm run generate`, and commit the regenerated
`schema/*.json` with the change. A test fails when they are stale.
