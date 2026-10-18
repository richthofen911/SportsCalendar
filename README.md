# Sports Calendar — 2026-27

A local calendar with two categories, each independently toggleable:

- **Football** — every first-team tie of the current season for Real Madrid, FC
  Barcelona, Arsenal, Manchester City, Bayern Munich and Paris Saint-Germain
  (league, domestic cup, super cup, Champions League, intercontinental), plus
  **league tables** for the Premier League, La Liga, Bundesliga and Ligue 1.
- **Formula 1** — all 23 rounds of the 2026 championship: circuit, race start
  time, weekend opening, and the winner, pole sitter and fastest lap once run.

No accounts, no API keys, no build step: `index.html` reads one generated data
file and works straight from `file://`. The calendar is also hosted at
<https://sportscalendar-da1q.onrender.com/>, where a Node service on Render reads
Postgres on Neon — see [Deploy it](#deploy-it-render--neon). Nothing below needs
that; it is just where the public copy lives.

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

## Where it lives

The calendar is served from **Render**, reading Postgres on Neon:

```
https://sportscalendar-da1q.onrender.com/
```

GitHub Pages is retired. It served the committed files, which only changed when
this Mac pushed — so a finished match could sit at half time for hours, and the
public site drifted from the database without anything noticing. Anything that
used to point at a `github.io` address should point at the Render URL instead,
including calendar subscriptions:

- **Google Calendar** — Settings → Imports & exports → **Other calendars → By URL**
  and paste `https://sportscalendar-da1q.onrender.com/calendar/all-events.ics`.
- **Apple Calendar** — File → New Calendar Subscription with the same URL.
  Set "Reload every hour".

The committed `data/` and `calendar/` files are still generated and still make
`file://` work, but they are a local convenience now, not what the site serves.
**`npm run db:pull`** brings them in line with the database. The old
`npm run publish` and `npm run scheduler:install` were part of the Pages
workflow; if either was installed, `npm run scheduler:uninstall` removes it.

The **Refresh data** button in the header is shown only when the page comes from
`localhost` or a private network address, so it never appears on the public site.

## Deploy it (Render + Neon)

A static file cannot keep a copy of the calendar in a database or refresh itself
while this Mac is asleep. Those two jobs are what the deployment adds.

```
                    cron */15, gated on a match in play
                                   │
                                   ▼
   Wikipedia / ESPN ──▶  Neon Function `refresh`  ──▶  Postgres on Neon
                                                              │
                                          Render web service ◀┘
                                                              │
                                    index.html · /data/calendar.js · *.ics
```

| Piece | Where | Job |
| --- | --- | --- |
| Project `sports-calendar` | Neon, `aws-us-east-2` | Holds the calendar in Postgres |
| Function `refresh` | branch `main` | Re-runs the build, replaces every row |
| Trigger `calendar-live` | `*/15 * * * *` UTC | Ticks every 15 minutes; rebuilds only when a match is in play |
| Web service | Render, `render.yaml` | Serves the site, the logos and the `.ics` files from Postgres |

The web service reads the database and serves `/data/calendar.js` and
`/calendar/*.ics` from it, so the page needs no change at all — it still just
loads a script tag. Locally, without `DATABASE_URL`, it falls back to the
committed files, which is the behaviour `npm run serve` always had. On Render it
does not: the platform sets `RENDER`, and a deployment without a database
refuses to start rather than quietly serving a frozen snapshot.

### Refreshing during a match

The score is the part that changes while you are watching, and it is the part
Wikipedia is worst at: its season pages are edited by hand, so a result can land
hours after full time, or not on the same day at all. ESPN publishes the score
while the match is running and again at the final whistle, so **results come from
ESPN and the schedule still comes from Wikipedia** — fixtures, venues, referees,
kick-off times and the league tables are unchanged.

That makes the two kinds of tick different work:

| Tick | When | What it does |
| --- | --- | --- |
| **live** | a fixture is in play | 1–3 ESPN scoreboard requests, patching only the scores and clock of the rows on screen |
| **full** | nothing live, or 12 h since the last full rebuild | the Wikipedia parse, with the ESPN result overlay applied, replacing the whole snapshot |
| **skip** | otherwise | two small queries and exit |

```
kick-off − 5 min  ┌────────────────────────────────────────────────┐  +150 min
                  │  every 15 min: ESPN, 1–3 requests, ~1 s        │
──────────────────┘  (no Wikipedia, no snapshot rewrite)          └──────────
       a tick with nothing live costs two queries and exits
```

"In play" is a clock window, not a status. A fixture that kicked off forty
minutes ago is live but not finished, so the window runs from five minutes before
kick-off to two and a half hours after — enough for stoppage time, extra time and
penalties, a Grand Prix running long, or a delayed start. `status = 'played'`
ends it early. During that window the row shows the running score and the ESPN
clock (`0-1` with a `67'` badge) and stays under **Upcoming**, because it is not
a result yet.

The full rebuild applies the same overlay, which matters more than it looks: a
rebuild that ignored ESPN would happily overwrite a score it had just published
with the empty one Wikipedia still had.

With nothing live, the function rebuilds once the data is more than twelve hours
old (`REFRESH_MAX_AGE_HOURS` for a different floor), which preserves the old
twice-daily rhythm. A quiet tick returns
`{"ok":true,"skipped":true,"reason":"no match in play"}` and logs one line.

The cost is now roughly two Wikipedia crawls on a quiet day and a handful of ESPN
requests per quarter hour while a fixture is running, instead of fourteen
Wikipedia pages every time — which also keeps the schedule clear of Wikipedia's
rate limit on a busy Saturday.

### Logos

Two sets of images, both committed rather than hotlinked.

**The six clubs and four leagues** come from Wikipedia: `npm run refresh` asks
for every lead image in one batched call and only re-downloads one whose source
changed. `assets/logos/manifest.json` records where each came from.

**Every other club in a fixture** comes from ESPN's team lists, downloaded on
demand into `assets/logos/teams/` — 89 of the 90 opponents in the current season
(ESPN does not carry 1. FC Köln). Each file is named by a slug derived from the
club name, using the same normalisation as `tools/logos.mjs`, so the page builds
the path itself and no lookup table has to travel with the payload — which is
also why the Neon refresh Function can name a crest it will never see.
`assets/logos/teams/manifest.json` keeps the ESPN id and URL for each. Only
names with no file on disk are looked up, so a settled season costs no requests;
a new cup opponent costs one listing and one download.

These are non-free, fair-use images — crests and league wordmarks are trademarks
— so vendoring them is a deliberate choice for this repository rather than a
general-purpose licence. It is also why the tree carries about 5 MB of PNGs.

Where the crest appears differs by layout, because the space does:

| Layout | Placement |
| --- | --- |
| **Month** | a crest before each club name inside the day pill |
| **List** | the fixture line is framed by the two crests — home on the left, away on the right. There is no separate clubs column: the fixture already names both teams, so a second column of short codes was saying it twice |
| **Phone** | the same row, re-flowed into a card, with the goals moved between the two club names — `Home 2 : 1 Away` — because the Result column sits a long way from either name on a narrow screen. The corner keeps only the live clock |
| **Standings** | beside each tracked club, with the league's mark on the table heading |

A missing image removes itself rather than leaving a broken-image box: an
opponent with no crest simply shows its name, and a tracked club falls back to
its colour dot.

### The database

Seven tables. `events` and `standings_rows` are ordinary columns you can query
and index; each row also carries a `doc jsonb` holding the original object. That
second copy is deliberate: `data/calendar.js` is a wire format, not a data
model — `round` is a number for Formula 1 and a string like `Final` for a cup
tie, `scoreExtra` is `""` on one row and `null` on the next — and rebuilding it
by hand from typed columns is a slow drift of small mismatches. The columns are
what you query; `doc` is what guarantees the JSON comes back exactly as it went
in. `npm run db:verify` writes a payload, reads it back, and rolls the
transaction back, so it can prove that without changing what is stored.

```sql
-- Who has played most, straight out of the relational columns:
select club_name,
       count(*) filter (where status = 'played') as played,
       count(*) as total
  from events where category = 'football'
 group by club_name order by club_name;
```

```sh
neon psql                    # psql against the linked branch, no local client needed
npm run db:status            # what is in there, and when it was last refreshed
npm run db:push              # data/calendar.json  ->  Postgres
npm run db:pull              # Postgres  ->  data/ and calendar/
npm run db:verify            # prove the round trip, changing nothing
```

`db:pull` is the one that matters once the cron is running: the database is then
the freshest copy, and this is how the committed files — what a double-clicked
`index.html` serves — are brought back in line with it. The hosted site does not
read them; it reads the database.

### How much history it keeps

Six months, rolling. The calendar is a live schedule, not an archive, so a full
rebuild only writes matches that finished inside the window — `RETENTION_MONTHS`,
declared for the Function in `neon.ts` and picked up from the environment by
`npm run refresh`. Future fixtures are always kept: they are the calendar.

There is no separate cleanup job to forget. Every rebuild replaces the snapshot
wholesale, so an expired match simply stops being written back, and the
`refresh_runs` log is trimmed on the same clock.

The window rolls, which means it eventually eats the start of the current
season. Right now it already excludes the first three Formula 1 races (March
2026); from around March 2027 it would begin dropping August's football. Set
`RETENTION_MONTHS=12` — in `neon.ts` for the Function, and in the environment for
local builds — if you would rather keep a whole season in view.

### The Render service

`https://sportscalendar-da1q.onrender.com/` runs `tools/serve.mjs` and must be
pointed at Neon. `render.yaml` declares the service, but the four environment
variables below are `sync: false`, so they are set in the dashboard — and a
service created by hand starts without them:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the pooled Neon string — `neon env pull` writes it to `.env.local`; or Neon console → Connect |
| `REFRESH_TOKEN` | the value of `REFRESH_TOKEN` in `.env.local` |
| `REFRESH_FUNCTION_URL` | `neon functions get refresh` — the URL with `/refresh` on the end |
| `REQUIRE_DATABASE` | `true` (implicit on Render, but be explicit) |

Then **Manual Deploy → Deploy latest commit**, and check the two things that
tell you it is wired up correctly:

```sh
curl -s https://sportscalendar-da1q.onrender.com/healthz
# {"ok":true,"database":"neon","generatedAt":"…","events":307}
```

`"database":"files"` means `DATABASE_URL` is missing: the service is serving the
committed snapshot, which is exactly the failure that made a finished match read
"HT". Since the service detects Render's `RENDER` variable, a deployment without
a database now **fails its health check** rather than starting in that state.

If `/healthz` returns `503` with `"database":"neon"`, the connection works but
the snapshot is empty — run `npm run db:push`.

The free plan spins the service down when nobody visits, so the first request
after a quiet spell takes a few seconds to wake. The Neon compute does the same;
both are fine for a personal calendar.

### Refreshing

The trigger is the normal path — nothing has to be awake. To refresh by hand,
either wait for the next tick or call the Function:

```sh
set -a; . ./.env.local; set +a
curl -X POST "${NEON_FUNCTION_REFRESH_BASE_URL}/refresh" \
     -H "Authorization: Bearer $REFRESH_TOKEN"
```

A manual call always rebuilds; only the scheduled ticks are allowed to decline.
A refresh fetches fourteen Wikipedia pages with a two-second gap and writes
every row in one transaction, so it takes about 35 seconds and the site never
shows a half-written calendar. `POST /api/refresh` on the Render service does the same
thing by calling the Function; it is authorised by `REFRESH_TOKEN`, and from
your own LAN it works without one (which is what the in-page **Refresh data**
button uses). It is deliberately not open to the public internet: a caller
claiming `Host: localhost` is still refused, because the check is on the address
the request actually came from.

### Changing the Neon side

`neon.ts` is the branch's infrastructure as code — the function, its
environment, and the cron trigger.

```sh
neon config plan     # dry run: what a deploy would change
neon deploy --env .env.local
```

Two things worth knowing:

- `plan` always lists `~ function refresh`. It has no way to compare bundles, so
  an existing function always reads as "would be updated". It is not drift.
- An environment-variable change only reaches a fresh isolate, so a warm one can
  keep serving the previous value for a request or two. Retry before assuming
  the value is wrong.

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
index.html          the calendar UI (reads data/calendar.js)
tools/build.mjs     CLI: build, then write data/ + calendar/
tools/pipeline.mjs  fetch → parse → payload + .ics, touching no files
tools/site-files.mjs  the only place that writes data/ and calendar/
tools/db.mjs        the Postgres schema, and reading/writing a snapshot
tools/db-push.mjs   CLI: db:push / db:pull / db:verify / db:status
tools/parse.mjs     Wikipedia markup → normalised matches
tools/wiki.mjs      throttled fetch with .cache/
tools/espn.mjs      live + final results from ESPN's public scoreboard
tools/teams.mjs     club-name normalisation shared by ESPN matching and verify
tools/logos.mjs     club crests + league logos into assets/logos/
tools/ics.mjs       RFC 5545 writer (CRLF, 75-octet folding, escaping)
tools/f1.mjs        F1 calendar + results, ESPN start times
tools/standings.mjs league results -> tables
tools/serve.mjs     the web server: files on disk, or Postgres when configured
tools/publish.mjs   retired Pages step: commit the generated files, push
tools/install-scheduler.mjs  retired LaunchAgent that ran the Pages publish
tools/verify.mjs    cross-check against ESPN
tools/clubs.mjs     the six clubs, colours, crest pages and league list
src/refresh/index.ts  the Neon Function the trigger calls
neon.ts             Neon branch policy: the function and its schedule
assets/logos/       club + league crests, with a source manifest
assets/logos/teams/ every opponent crest, named by club-name slug
render.yaml         Render blueprint for the web service
data/               calendar.json + calendar.js (generated)
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
refresh, for the fixtures, venues, officials and league tables. Results and F1
start times come from ESPN, which publishes them while the match is running
rather than when someone gets round to editing a page.
