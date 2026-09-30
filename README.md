# Sports Calendar — 2026-27

A local calendar with two categories, each independently toggleable:

- **Football** — every first-team tie of the current season for Real Madrid, FC
  Barcelona, Arsenal, Manchester City, Bayern Munich and Paris Saint-Germain
  (league, domestic cup, super cup, Champions League, intercontinental), plus
  **league tables** for the Premier League, La Liga, Bundesliga and Ligue 1.
- **Formula 1** — all 23 rounds of the 2026 championship: circuit, race start
  time, weekend opening, and the winner, pole sitter and fastest lap once run.

No accounts, no API keys, no build step, nothing running in the background.

## Open it

On this Mac, double-click `index.html` (or `open index.html`). Month grid and
agenda list, filters by category, team, competition and status, free-text
search, and a local-vs-UTC time switch. Click any fixture for venue, scorers, bookings,
attendance, referee and the official report link. Keyboard: `←` `→` change
month, `Esc` closes the detail panel.

## Check it from your phone

```sh
npm run serve            # prints the Wi-Fi URL, e.g. http://192.168.0.16:4173/
```

Open that URL on a phone on the same Wi-Fi. Nothing is uploaded anywhere — the
server only reads files from this folder and binds to your LAN.

## Categories and standings

The filter bar has two levels. The chips (**Football**, **Formula 1**) show or
hide a whole category everywhere at once — grid, agenda, search, standings and
the counts. Underneath, each active category that has teams gets **one
dropdown** listing them with a tick box each; its label summarises the choice
("Clubs · All 6" or "Clubs · 4 of 6") and offers *Select all* when you have
narrowed it. Formula 1 is a single series, so it contributes no dropdown —
switch football off and the clubs menu disappears with it.

Which teams a category offers comes from the data, not the markup: add a
category with `teams: [...]` in `tools/clubs.mjs` and the dropdown appears by
itself. Both choices are remembered in the browser.

**Calendar / Standings** switches the panel. Standings shows the four league
tables — position, played, W-D-L, goals, GD, points — with your six clubs
marked by their own colour. The tables are *computed* from each season's
results rather than copied from a screen, and they are re-derived on every
refresh, so a matchday moves the table.

## One layout control

The **Auto · Month · List · Phone** control in the filter bar sets both the
presentation and the view, so there is nothing else to switch:

| Choice | What you get |
| --- | --- |
| **Auto** (default) | Phone layout on a phone, month grid on a desktop |
| **Month** | Desktop layout, calendar grid with the month navigator |
| **List** | Desktop layout, agenda table with column headers |
| **Phone** | Cards instead of the grid and the table, fixture details as a bottom sheet, tighter filter bar |

Auto detects on viewport width *and* pointer type, so a phone held sideways still
gets the phone layout. Any explicit choice is remembered in that browser, and
Auto is one tap away if you want the device decision back.

On iPhone, **Share → Add to Home Screen** gives it its own icon and a full-width
status bar.

### Where the list starts

*Upcoming* opens at the top, on the next fixture. *Played* and *All* are read
backwards from now, so they land on today instead of on the season's opening
weekend: *All* scrolls to a **Today** divider with the results you have missed
just above it, and *Played* goes to the most recent result. Month view follows
the same rule — *Played* and *All* open on the current month, *Upcoming* on the
month with the next game. Changing the status or the view re-lands the scroll;
typing in search or toggling a club leaves it where you were.

On iPhone, **Share → Add to Home Screen** gives it its own icon and a full-width
status bar.

Keep the terminal open while you use it, and note that a sleeping Mac stops
serving — `caffeinate -i npm run serve` holds the machine awake while it runs.

**Refresh data** appears in the header only when the page is served over HTTP.
Tapping it re-runs the whole fetch-and-build on the Mac and reloads the page, so
you can pull new scores from the sofa. It is a plain POST with no auth, so keep
this on your own Wi-Fi and don't port-forward the address.

## Publish to GitHub Pages

The site is static, so GitHub Pages serves it and this Mac stays the only thing
that fetches data:

```
Wikipedia/ESPN  --(npm run publish)-->  GitHub repo  --(Actions)-->  Pages site
```

- **`npm run publish`** — re-fetches, rebuilds `data/` and `calendar/`, commits
  only those generated files and pushes. It makes no commit when nothing
  changed, so a scheduled run on a quiet day is a no-op. Add `--dry-run` to
  commit locally without pushing.
- **Pages source** is the `main` branch root, so a push publishes whatever is
  committed. No build step and no network access on GitHub's side — the page can
  only ever show what this machine fetched. It publishes the whole repository,
  which is why `tools/` is also reachable at the site URL; nothing there is
  secret, but if you would rather publish only the site, switch Settings →
  Pages → Source to "GitHub Actions" and add a workflow that uploads just
  `index.html`, `data/calendar.js` and `calendar/*.ics`.
- **`npm run scheduler:install`** — optional. Installs a per-user LaunchAgent
  (no admin rights) that runs the publish step at 07:15 and 19:15. Override with
  `--times 06:00,22:00`; remove with `npm run scheduler:uninstall`. A job missed
  while asleep runs on the next wake; while powered off it is skipped. Log:
  `~/Library/Logs/SportsCalendar-refresh.log`.

Site: `https://<owner>.github.io/SportsCalendar/`

Because the calendar files are served over plain HTTP from that URL, a calendar
app can **subscribe** to them instead of importing a snapshot — it then updates
itself on every publish, with no re-import:

- **Google Calendar** — Settings → Imports & exports → **Other calendars → By URL**
  and paste `https://<owner>.github.io/SportsCalendar/calendar/all-events.ics`.
- **Apple Calendar** — File → New Calendar Subscription with the same URL.
  Set "Reload every hour".

The **Refresh data** button in the header is shown only when the page comes from
`localhost` or a private network address, so it never appears on the public site
where there is no server to call.

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
| `all-events.ics` | every fixture and race, one entry each |
| `real-madrid.ics`, `barcelona.ics`, `arsenal.ics`, `man-city.ics`, `bayern.ics`, `psg.ics` | that club's own run of fixtures |
| `formula-1.ics` | the 23 Grands Prix |

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
tools/f1.mjs        F1 calendar + results, ESPN start times
tools/standings.mjs league results -> tables
tools/serve.mjs     LAN static server + /api/refresh
tools/publish.mjs   refresh, commit the generated files, push to GitHub
tools/install-scheduler.mjs  optional twice-daily LaunchAgent
tools/verify.mjs    cross-check against ESPN
tools/clubs.mjs     the six clubs, colours and source pages
data/               matches.json + matches.js (generated)
calendar/           .ics files (generated)
.cache/             raw page snapshots (generated)
```

## What the data can't know

- **F1 times** come from ESPN's public feed (Wikipedia's calendar gives only the
  race day). Round names, circuits and race results come from Wikipedia, so a
  race that ESPN lists under a sponsor title still reads plainly here.
- **League tables** reflect whatever the season page has recorded; the header of
  each table shows the date Wikipedia last updated it.
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
