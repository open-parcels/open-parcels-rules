# Data formats

Every data file has a JSON Schema in [`schema/`](../schema/), generated from the TypeScript
schemas in [`src/schema/`](../src/schema/). The schemas are the reference; this page explains
the intent.

## Carriers (`data/carriers.yaml`)

```yaml
carriers:
  - id: dhl                       # lower case; used by every other file
    name: DHL
    aliases: [DHL Paket, Deutsche Post]   # matched ignoring case, accents and punctuation
    countries: [DE]               # ISO 3166-1 alpha-2
    domains: [dhl.de, dhl.com]    # sender and tracking-page domains; subdomains match
    courier_codes: [canada_post]  # tracking-number files that belong to this carrier
    upu_countries: [DE]           # S10 numbers (RR123456785DE) issued in these countries
    tracking_urls:                # keys: default, a language (de) or a full tag (de-AT)
      default: "https://example.com/track?id={tracking_number}"
    tracking_number_pattern:      # what the carrier's own tracker accepts (optional)
      { pattern: "^[A-Z0-9]{8,40}$", flags: [i] }
    crossref: { 17track: "7041" } # identifiers in other systems, as strings
```

A `tracking_urls` key is a language (`de`) or a full tag (`de-AT`, also used for a regional site
such as `en-NZ`). `{tracking_number}` is always filled in; any other lower-case placeholder, such
as `{postcode}`, comes from the caller's `params`. A template whose placeholders are not all given
is skipped for the next, less specific key, so `default` should need only the number where the
carrier allows it. Every value is URL-encoded.

`tracking_number_pattern` is a plausibility check before a lookup is sent, anchored with `^` and
`$`. It is not detection: detection uses the tracking-number formats below, with check digits.

A tracking-number file's `courier_code` names its carrier when it equals a carrier `id` or is
listed in `courier_codes`. S10 numbers belong to the carrier whose `upu_countries` contains the
number's country suffix, or to the pseudo-carrier `upu` when none does.

## Tracking numbers (`data/tracking-numbers/*.json`)

The same schema as the community tracking_number_data courier files, so both sets are read by
one engine:

- `regex`: a string, or an array of strings joined into one pattern. Patterns tolerate
  whitespace between characters (`([0-9]\s*){11}`), because numbers are often printed in
  groups.
- Named groups: `SerialNumber` and `CheckDigit` feed the checksum; others (`ServiceType`,
  `CountryCode`, ...) feed `additional` lookups.
- `validation.checksum`: one of `mod10` (`evens_multiplier`, `odds_multiplier`, `reverse`),
  `mod7`, `s10`, `luhn`, `mod_37_36` (`alphabet`) and `sum_product_with_weightings_and_modulo`
  (`weightings`, `modulo1`, `modulo2`). Positions count from the left starting at 0, so
  "evens" are the 1st, 3rd, 5th... characters.
- `validation.serial_number_format.prepend_if`: prepends `content` to the serial before the
  checksum when the serial matches `matches_regex`. The GLS overlay uses it to add the constant
  1 its check digit needs.
- `validation.additional.exists`: names of `additional` lookups that must find a row.
- `test_numbers.valid` and `.invalid`: required; the tests run every one of them.

Use our own files for formats upstream lacks. Each entry needs an `id`.

## Status tables (`data/status/<carrier>.yaml`)

```yaml
carrier: gls
entries:
  - { match: { code: DELIVEREDPS }, status: at_pickup_point, pickup: true }
  - { match: { text: 'niedoręczona', flags: [i] }, status: problem }
  - { match: { text: 'doręczona', flags: [i] }, status: delivered, confirmed: false }
tests:
  - { input: { code: DELIVEREDPS }, status: at_pickup_point, pickup: true }
  - { input: { code: stored }, status: null }      # must stay unmapped
```

A raw status is `{ code?, text?, fields? }`. There are four kinds of match, tried in this order
(within one kind, the first hit in file order wins):

| Match | Matches when |
| --- | --- |
| `{ fields: { statusType: STATUS_OK, statusCode: "32" } }` | every listed raw field equals its value (trimmed, case kept); for statuses that depend on two or more fields |
| `{ code: DELIVEREDPS }` | the whole code (trimmed; an exact match wins over a case-insensitive one) |
| `{ code_prefix: RETURN_ }` | the code starts with this text, ignoring case; tried after exact codes |
| `{ text: "zugestellt", flags: [i] }` | the regex is found in the text; add `fields: { lang: fr }` to require raw fields too |

- Numeric or composite values are written as `field:value` (`fortschritt:4`,
  `parcelStatusType:5`) so callers can pass them as codes. A carrier with several vocabularies
  keeps them apart the same way (`state:14`, `express:2100`).
- A `fields` condition on text entries is also how one table answers a second question about a
  text: entries with `fields: { use: locker }` say whether a sentence puts the parcel in a
  locker, while status entries carry `fields: { use: status }`.
- Optional entry fields: `pickup: true` (going to or waiting at a pickup point), `stage` (an
  integer, higher is later, for ordering events with the same time), `label` (a neutral display
  text for carriers whose own wording carries personal data) and `note`. `stage` and `label` are
  returned with the mapping.
- `ignore` lists values that say the item is no parcel at all, with the email event they amount
  to: `{ match: { text: "^storniert", flags: [i] }, event: order_cancelled }`. They are matched
  like entries but never returned by mapping; `ignoredStatus` reads them.
- `confirmed: false` marks a plausible guess not yet seen in real data; consumers may log
  these once.
- Map a value to `unknown` only when it is known to carry no information; leave values that
  should not change the status (booking confirmations and the like) out entirely, so the
  status falls back to the newest history entry that maps.

Test vectors may also check `pickup`, `stage`, `label` and `ignored` (the event an ignore entry
gives, or null).

## Carrier keys (`data/keys.yaml`)

Fixed public values carriers expect from every client: keys their website or app sends, public
app client ids, app versions and the User-Agents a carrier insists on. Never a user's
credentials.

```yaml
keys:
  - carrier: evri               # carrier id
    name: website_key           # unique per carrier
    purpose: "`apikey` header the public tracking website sends."
    source: website             # website or app
    last_verified: 2026-11-18   # the date the value was last seen working
    value: "..."
```

Update `last_verified` whenever a value is checked against the live service.

## Locales (`data/locales/<lang>.yaml`)

Word lists, not regexes, so the engine can combine languages: `months` (12 lists),
`weekdays` (7 lists, Monday first), `relative_days` (word to day offset), `past_days` (words
that name today or a past day on their own, such as timeline headers; not used by the arrival
parser), `lead_ins`
(words that announce an arrival), `range_separators`, `window_openers`, `deadline_words`,
`point_words`, `hour_words`, `am_markers`, `pm_markers`, `tracking_keywords` (used by the email
fallback) and two regex lists: `negatives` (the text announces no arrival) and `cut_markers`
(ignore everything from here, e.g. "previously expected").

The parser's rules:

- A whole day is `allDay` from 00:00 to the next day's 00:00 (exclusive) in the given zone.
- A weekday means its next occurrence, today included.
- A date without a year is this year's, unless that is before yesterday: then next year's.
- A range whose end falls before its start moves the end into the next year.
- A bare relative day or weekday only counts after a lead-in ("Arriving", "Zustellung") or
  next to a time; a date with a month name or in numeric form counts anywhere.
- "2 - 4:30 pm": a marker on one end applies to the other when that keeps the order.
- A time without a day is today; a deadline ("by 9 pm", "bis 21 Uhr") runs from 00:00.

Every vector is `{ text, now, time_zone, expect }`, with `expect: null` for texts that must
not parse.

## Email rules (`data/mail/<id>.yaml`)

See [mail-rules.md](mail-rules.md).
