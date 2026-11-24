# Consuming the package

## Installing

The package ships prebuilt: `dist/` (engine, declarations, `bundle.json`), `data/` and
`schema/`. It has no install scripts and one runtime dependency (`zod`).

`dist/` is not committed, so a plain git dependency would install a package without its
engine. Use a packed tarball instead:

```sh
# in this repository
npm run gate            # or at least: npm run build
npm pack                # writes open-parcels-rules-<version>.tgz
```

```sh
# in the consuming project
cp ../open-parcels-rules/open-parcels-rules-2.0.0-dev.0.tgz vendor/
npm install ./vendor/open-parcels-rules-2.0.0-dev.0.tgz
```

npm records it as a `file:` dependency, with an integrity hash in the lockfile. Nothing runs
at install time, so npm 11's `allowScripts` needs no entry. The same tarball can be attached
to a release and installed from its URL.

## API

```ts
import {
  loadRules,
  carriers,
  findCarrier,
  trackingUrl,
  detectTrackingNumbers,
  mapStatus,
  resolveStatus,
  parseArrival,
  parseMail,
} from "open-parcels-rules";
import type { Rules, ParcelStatus, CarrierInfo, TrackingCandidate } from "open-parcels-rules";
```

| Function | Returns |
| --- | --- |
| `loadRules(): Rules` | The bundled rules, read from `dist/bundle.json`, validated and compiled on the first call and cached. Synchronous. |
| `rulesFromBundle(data: unknown): Rules` | The same from bundle data you loaded yourself (a newer `bundle.json`, say). Throws a zod error on invalid data. |
| `carriers(rules)` | Every `CarrierInfo`. |
| `findCarrier(rules, nameOrAlias)` | A carrier by id, name or alias; case, accents and punctuation are ignored. |
| `trackingUrl(rules, carrierId, number, locale?, params?)` | The tracking page: tries the full locale tag, then the language, then `default`, skipping a template whose placeholders (such as `{postcode}`) `params` does not fill. |
| `detectTrackingNumbers(rules, text, hints?)` | Every plausible `{ carrier, trackingNumber, confidence, checksumValid, types }`, best first. |
| `mapStatus(rules, carrier, { code?, text?, fields? })` | `{ status, pickup?, confirmed, stage?, label? }` or `null` when the table lacks the value. |
| `ignoredStatus(rules, carrier, raw)` | The email event an `ignore` entry gives the value (`order_cancelled`, `refund_issued`, ...), or `null`. |
| `findCarrierKey(rules, carrier, name)` | `{ carrier, name, purpose, source, lastVerified, value }` from `keys.yaml`, or `undefined`. |
| `carrierKeys(rules, carrier)` | Every key listed for a carrier. |
| `pastDayOffset(rules, word, locales?)` | The offset (0 today, -1 yesterday) a standalone word names, or `undefined`. |
| `resolveStatus(rules, carrier, latest, history)` | `{ status, source, unmapped }`; see below. |
| `parseArrival(rules, text, { now, timeZone, locales? })` | `{ from, to, allDay, matched }` or `null`. |
| `parseMail(rules, mail)` | An array of `MailParseResult`. |

Additions to the contract: `rulesFromBundle`, `portabilityProblems(pattern)` (the regex-subset
check, for tools that edit data), `PARCEL_STATUSES`, the `types` field on tracking
candidates (format ids such as `dhl_paket_nve`), and `event` on email results.

### Detection and confidence

Confidence is comparable within one call. It starts from the format (a passing check digit
counts more than a bare digit run, a fixed prefix such as `1Z` or `00340434` adds a little),
drops when several carriers share the number, and moves with hints: the named carrier +0.3
(others -0.15), the sender's carrier domain +0.25 (others -0.1), a country the carrier serves
+0.05 (others -0.1). A number with a failed check digit is dropped unless `hints.carrier` names
its carrier; then it comes back with `checksumValid: false` and a low confidence. A short
number inside a longer valid one on the same line is not reported.

### Status resolution

`resolveStatus` maps `latest`; if that does not map (or maps to `unknown`), it uses the newest
entry of `history` that maps. **History is ordered newest first.** `unmapped` holds the raw
code or text of `latest` when the table did not know it, so you can warn about it once;
it is `null` when `latest` mapped or was known to say nothing.

### Arrival windows

`from` and `to` are ISO 8601 with the offset of `timeZone` at that instant, so a window across
a daylight-saving change carries two different offsets. Whole days end at the next day's
00:00 (exclusive). A deadline ("by 9 pm") starts at 00:00; a single time ("um 15:30 Uhr") has
`from === to`. An invalid IANA zone throws a `RangeError`.

### Emails

```ts
parseMail(rules, {
  from: '"DHL Paket" <noreply@dhl.de>',
  subject: "Ihr DHL Paket kommt heute",
  text,                 // optional
  html,                 // optional; used as text when there is no plain part
  date,                 // the Date header; anchors "heute", "tomorrow" and year inference
  timeZone: "Europe/Berlin", // for arrival dates; UTC when omitted
});
```

Each result has `ruleId`, `kind`, `trackingNumbers`, `orderNumbers` and, when found,
`carrier`, `status`, `event`, `arrival`, `items`, `trackingUrl` and `pickupCode`.

**`pickupCode` is a secret**: it opens a locker or proves identity at a counter. Show it to
the recipient, store it like a credential, and never write it to logs, metrics or error
reports.

## Python

`python/open_parcels_rules` reads `dist/bundle.json` with the standard library only and offers
`load_rules`, `validate_tracking_number`, `detect_tracking_numbers` (no confidence model),
`map_status` and `ignored_status`. `python -I python/run_vectors.py` runs the tracking and status vectors from
`dist/vectors.json`. Arrival parsing and email rules are TypeScript only for now.
