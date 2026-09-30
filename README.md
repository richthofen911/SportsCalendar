# Sports Calendar — 2026-27

A local fixture calendar for six clubs: Real Madrid, FC Barcelona, Arsenal,
Manchester City, Bayern Munich and Paris Saint-Germain. Every first-team tie of
the current season that has been played or is scheduled — league, domestic cup,
super cup, Champions League and intercontinental matches.

No accounts, no API keys, no build step, nothing running in the background.

## Open it

On this Mac, double-click `index.html` (or `open index.html`). Month grid and
agenda list, filters by club / competition / status, free-text search, and a
local-vs-UTC time switch. Click any fixture for venue, scorers, bookings,
attendance, referee and the official report link. Keyboard: `←` `→` change
month, `Esc` closes the detail panel.

## Check it from your phone

```sh
npm run serve            # prints the Wi-Fi URL, e.g. http://192.168.0.16:4173/
```

Open that URL on a phone on the same Wi-Fi. Nothing is uploaded anywhere — the
server only reads files from this folder and binds to your LAN.

On a small screen the calendar drops the month grid (seven columns are
unreadable at that width) and shows the agenda instead: one card per fixture,
grouped by month, landing on your next games. Filters scroll horizontally, and
fixture details open as a bottom sheet. On iPhone, **Share → Add to Home Screen**
gives it its own icon and full-width status bar.

Keep the terminal open while you use it, and note that a sleeping Mac stops
serving — `caffeinate -i npm run serve` holds the machine awake while it runs.

**Refresh data** appears in the header only when the page is served over HTTP.
Tapping it re-runs the whole fetch-and-build on the Mac and reloads the page, so
you can pull new scores from the sofa. It is a plain POST with no auth, so keep
this on your own Wi-Fi and don't port-forward the address.

## Refresh it by hand

```sh
npm run refresh          # re-parses the cached pages, ~1s
npm run refresh:force    # re-downloads the six pages, ~10s
```

`refresh:force` is what you want before a big week: scores move from *upcoming*
to *played*, and kick-off times that were still unconfirmed get filled in once
the TV selections are announced. The build prints a report (rows per club,
competitions, skipped blocks) and self-checks every `.ics` it writes. A running
`npm run serve` picks the new files up immediately — responses are `no-store`.

To confirm the data still agrees with an independent feed:

```sh
node tools/verify.mjs
```

It compares finished results, home/away and kick-off instants against ESPN's
public API and prints any disagreement.

## Put it in a real calendar

Under **Calendar files (.ics)** in the header, or directly from `calendar/`:

| File | Contents |
| --- | --- |
| `all-clubs.ics` | every fixture, one entry each |
| `real-madrid.ics`, `barcelona.ics`, `arsenal.ics`, `man-city.ics`, `bayern.ics`, `psg.ics` | that club's own run of fixtures |

- **Apple Calendar** — open the file, choose the target calendar, then add again
  later to update (imported events are copies, not a live feed).
- **Google Calendar** — Settings → Imports & exports → import the `.ics`.
- **Phone** — AirDrop or save the file and open it.

UIDs are derived from the fixture itself and stay the same across refreshes, so
re-importing updates existing events rather than stacking duplicates.

## Layout

```
index.html          the calendar UI (reads data/matches.js)
tools/build.mjs     fetch → parse → data + .ics, with a printed report
tools/parse.mjs     Wikipedia markup → normalised matches
tools/wiki.mjs      throttled fetch with .cache/
tools/ics.mjs       RFC 5545 writer (CRLF, 75-octet folding, escaping)
tools/serve.mjs     LAN static server + /api/refresh
tools/verify.mjs    cross-check against ESPN
tools/clubs.mjs     the six clubs, colours and source pages
data/               matches.json + matches.js (generated)
calendar/           .ics files (generated)
.cache/             raw page snapshots (generated)
```

## What the data can't know

- **Kick-off times.** Roughly 120 of the 275 fixtures have a date but no
  confirmed time yet — the source genuinely says `TBC`. They appear as all-day
  entries in `.ics` and as `TBC` in the UI. They gain a time on a later refresh.
- **Domestic cups.** Rounds that have not been drawn contribute nothing yet, so
  a club's cup row count grows through the season. Placeholder `TBD vs TBD`
  blocks are skipped deliberately.
- **Friendlies** are excluded by design; only official competitions are kept.
- Times are read from the source with an explicit zone where possible; when a
  page gives only a clock time, the zone is inferred from the venue and the
  detail panel says so.
- A tie between two of the six tracked clubs is one fixture, not two — the
  combined calendar and month grid merge them and list both clubs.

Source: each club's 2026-27 season page on the English Wikipedia, parsed per
refresh.
