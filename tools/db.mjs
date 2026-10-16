// Postgres (Neon) storage for the calendar.
//
// Two layers live side by side in the same tables:
//
//   1. Ordinary relational columns on `events` / `standings_rows`, indexed and
//      queryable from SQL — this is the schema the database actually is.
//   2. A `doc` jsonb column holding the exact object the UI was built around.
//
// The second exists because `data/calendar.js` is a wire format, not a data
// model: `round` is a number for Formula 1 and a string like "Final" for a cup
// tie, `scoreExtra` is "" on one row and null on the next. Rebuilding that by
// hand from typed columns is a slow drift of small mismatches. Keeping the
// original object beside the columns makes a read-back byte-faithful while the
// columns stay the thing you query. `npm run db:verify` asserts the round trip.
import pg from "pg";

const { Pool } = pg;

export const SCHEMA_SQL = `
create table if not exists calendar_meta (
  id            boolean primary key default true check (id),
  generated_at  timestamptz not null,
  season        text        not null,
  source        text        not null,
  refreshed_by  text,
  event_count   integer     not null default 0
);

create table if not exists categories (
  id          text primary key,
  name        text not null,
  color       text not null,
  teams_label text,
  teams       jsonb not null default '[]'::jsonb,
  page        text,
  year        integer,
  ordinal     integer not null default 0,
  doc         jsonb not null
);

create table if not exists clubs (
  id      text primary key,
  name    text not null,
  short   text not null,
  color   text not null,
  page    text,
  aliases jsonb not null default '[]'::jsonb,
  ordinal integer not null default 0,
  doc     jsonb not null
);

create table if not exists events (
  id                  text primary key,
  ordinal             integer not null,
  category            text not null references categories(id) on delete cascade,
  kind                text,
  round               text,
  name                text,
  club                text,
  club_name           text,
  competition         text,
  phase               text,
  date                date,
  kickoff_utc         timestamptz,
  weekend_start_utc   timestamptz,
  time_confidence     text,
  status              text not null,
  local_clock         text,
  venue               text,
  location            text,
  country             text,
  home                boolean,
  opponent            text,
  score               text,
  score_extra         text,
  home_team           text,
  away_team           text,
  club_result         text,
  home_events         text,
  away_events         text,
  notes               text,
  referee             text,
  attendance          text,
  report              text,
  source_page         text,
  winner              text,
  winning_constructor text,
  pole                text,
  fastest_lap         text,
  circuit             text,
  fixture_key         text,
  doc                 jsonb not null
);

create index if not exists events_date_idx        on events (date);
create index if not exists events_category_idx    on events (category, date);
create index if not exists events_club_idx        on events (club, date);
create index if not exists events_competition_idx on events (competition);
create index if not exists events_status_idx      on events (status);

create table if not exists standings (
  league      text primary key,
  category    text not null,
  updated     text,
  source_page text,
  teams       integer,
  played      integer,
  ordinal     integer not null default 0,
  doc         jsonb not null
);

create table if not exists standings_rows (
  league   text    not null references standings(league) on delete cascade,
  ordinal  integer not null,
  position integer,
  code     text,
  team     text,
  played   integer,
  won      integer,
  drawn    integer,
  lost     integer,
  gf       integer,
  ga       integer,
  gd       integer,
  points   integer,
  club_id  text,
  primary key (league, ordinal)
);

create index if not exists standings_rows_team_idx on standings_rows (team);

create table if not exists refresh_runs (
  id           bigserial primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  source       text        not null,
  status       text        not null,
  event_count  integer,
  duration_ms  integer,
  summary      text,
  error        text
);
`;

/* ------------------------------------------------------------------ connection */

let defaultPool = null;

/**
 * pg 8.23 prints a loud deprecation warning for `sslmode=require` — the mode
 * Neon issues — because a future major will quietly weaken it. Today that mode
 * already means verify-full, so spelling it out keeps the same guarantee and
 * keeps the warning out of the server logs.
 */
export function normalizeSslMode(url) {
  if (!url || !/[?&]sslmode=/.test(url)) return url;
  return url.replace(
    /([?&]sslmode=)(prefer|require|verify-ca)(?=&|$)/i,
    "$1verify-full"
  );
}

export function databaseUrl(env = process.env) {
  return env.DATABASE_URL || env.DATABASE_URL_UNPOOLED || null;
}

/** A module-scope pool: Render and Neon Functions both reuse an isolate. */
export function getPool(env = process.env) {
  if (!defaultPool) {
    const url = databaseUrl(env);
    if (!url) throw new Error("DATABASE_URL is not set");
    defaultPool = new Pool({
      connectionString: normalizeSslMode(url),
      max: Number(env.PGPOOL_MAX || 5),
    });
    // Without a listener node-postgres turns an idle-client drop into an
    // uncaughtException and the process exits.
    defaultPool.on("error", (err) => console.error("[pg] idle client error:", err.message));
  }
  return defaultPool;
}

/** Direct (unpooled) connection — schema changes and bulk writes. */
export async function connectDirect(env = process.env) {
  const url = env.DATABASE_URL_UNPOOLED || databaseUrl(env);
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: normalizeSslMode(url), max: 1 });
  pool.on("error", (err) => console.error("[pg] idle client error:", err.message));
  return pool;
}

export async function closePool() {
  if (defaultPool) {
    const pool = defaultPool;
    defaultPool = null;
    await pool.end();
  }
}

export async function ensureSchema(pool) {
  await pool.query(SCHEMA_SQL);
}

/* ------------------------------------------------------------------ writing */

const text = (v) => (v === undefined || v === null ? null : String(v));
const bool = (v) => (v === undefined || v === null ? null : Boolean(v));
const stamp = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function eventRow(e, ordinal) {
  return {
    id: e.id,
    ordinal,
    category: e.category,
    kind: text(e.kind),
    round: text(e.round),
    name: text(e.name),
    club: text(e.club),
    club_name: text(e.clubName),
    competition: text(e.competition),
    phase: text(e.phase),
    date: text(e.date),
    kickoff_utc: stamp(e.kickoffUtc),
    weekend_start_utc: stamp(e.weekendStartUtc),
    time_confidence: text(e.timeConfidence),
    status: e.status || "upcoming",
    local_clock: text(e.localClock),
    venue: text(e.venue),
    location: text(e.location),
    country: text(e.country),
    home: bool(e.home),
    opponent: text(e.opponent),
    score: text(e.score),
    score_extra: text(e.scoreExtra),
    home_team: text(e.homeTeam),
    away_team: text(e.awayTeam),
    club_result: text(e.clubResult),
    home_events: text(e.homeEvents),
    away_events: text(e.awayEvents),
    notes: text(e.notes),
    referee: text(e.referee),
    attendance: text(e.attendance),
    report: text(e.report),
    source_page: text(e.sourcePage),
    winner: text(e.winner),
    winning_constructor: text(e.winningConstructor),
    pole: text(e.pole),
    fastest_lap: text(e.fastestLap),
    circuit: text(e.circuit),
    fixture_key: text(e.fixtureKey),
    doc: e,
  };
}

function standingRow(r, ordinal) {
  return {
    ordinal,
    position: r.position ?? null,
    code: r.code ?? null,
    team: r.team ?? null,
    played: r.played ?? null,
    won: r.won ?? null,
    drawn: r.drawn ?? null,
    lost: r.lost ?? null,
    gf: r.gf ?? null,
    ga: r.ga ?? null,
    gd: r.gd ?? null,
    points: r.points ?? null,
    club_id: r.clubId ?? null,
  };
}

const EVENTS_INSERT = `
insert into events (
  id, ordinal, category, kind, round, name, club, club_name, competition, phase, date,
  kickoff_utc, weekend_start_utc, time_confidence, status, local_clock, venue, location,
  country, home, opponent, score, score_extra, home_team, away_team, club_result,
  home_events, away_events, notes, referee, attendance, report, source_page, winner,
  winning_constructor, pole, fastest_lap, circuit, fixture_key, doc
)
select
  x.id, x.ordinal, x.category, x.kind, x.round, x.name, x.club, x.club_name, x.competition,
  x.phase, x.date, x.kickoff_utc, x.weekend_start_utc, x.time_confidence, x.status,
  x.local_clock, x.venue, x.location, x.country, x.home, x.opponent, x.score, x.score_extra,
  x.home_team, x.away_team, x.club_result, x.home_events, x.away_events, x.notes, x.referee,
  x.attendance, x.report, x.source_page, x.winner, x.winning_constructor, x.pole, x.fastest_lap,
  x.circuit, x.fixture_key, x.doc
from jsonb_to_recordset($1::jsonb) as x(
  id text, ordinal integer, category text, kind text, round text, name text, club text,
  club_name text, competition text, phase text, date date, kickoff_utc timestamptz,
  weekend_start_utc timestamptz, time_confidence text, status text, local_clock text,
  venue text, location text, country text, home boolean, opponent text, score text,
  score_extra text, home_team text, away_team text, club_result text, home_events text,
  away_events text, notes text, referee text, attendance text, report text, source_page text,
  winner text, winning_constructor text, pole text, fastest_lap text, circuit text,
  fixture_key text, doc jsonb
)`;

const STANDINGS_ROWS_INSERT = `
insert into standings_rows (
  league, ordinal, position, code, team, played, won, drawn, lost, gf, ga, gd, points, club_id
)
select
  x.league, x.ordinal, x.position, x.code, x.team, x.played, x.won, x.drawn, x.lost,
  x.gf, x.ga, x.gd, x.points, x.club_id
from jsonb_to_recordset($1::jsonb) as x(
  league text, ordinal integer, position integer, code text, team text, played integer,
  won integer, drawn integer, lost integer, gf integer, ga integer, gd integer,
  points integer, club_id text
)`;

/**
 * Replace the whole stored calendar with `payload`, inside a transaction the
 * caller owns. The builder regenerates every row each run, so the snapshot is
 * swapped rather than merged — a partial write is never visible.
 */
async function applySnapshot(client, payload, { source }) {
  const startedAt = Date.now();
  await client.query(SCHEMA_SQL);
  await client.query("delete from standings_rows");
  await client.query("delete from standings");
  await client.query("delete from events");
  await client.query("delete from clubs");
  await client.query("delete from categories");
  {
    for (const [i, c] of (payload.categories || []).entries()) {
      await client.query(
        `insert into categories (id, name, color, teams_label, teams, page, year, ordinal, doc)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)`,
        [
          c.id,
          c.name,
          c.color,
          text(c.teamsLabel),
          JSON.stringify(c.teams || []),
          text(c.page),
          c.year ?? null,
          i,
          JSON.stringify(c),
        ]
      );
    }

    for (const [i, c] of (payload.clubs || []).entries()) {
      await client.query(
        `insert into clubs (id, name, short, color, page, aliases, ordinal, doc)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)`,
        [
          c.id,
          c.name,
          c.short,
          c.color,
          text(c.page),
          JSON.stringify(c.aliases || []),
          i,
          JSON.stringify(c),
        ]
      );
    }

    const events = (payload.events || []).map(eventRow);
    if (events.length) await client.query(EVENTS_INSERT, [JSON.stringify(events)]);

    const standingRows = [];
    for (const [i, s] of (payload.standings || []).entries()) {
      await client.query(
        `insert into standings (league, category, updated, source_page, teams, played, ordinal, doc)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          s.league,
          s.category,
          text(s.updated),
          text(s.sourcePage),
          s.teams ?? null,
          s.played ?? null,
          i,
          JSON.stringify(s),
        ]
      );
      for (const [j, r] of (s.rows || []).entries()) {
        standingRows.push({ league: s.league, ...standingRow(r, j) });
      }
    }
    if (standingRows.length) {
      await client.query(STANDINGS_ROWS_INSERT, [JSON.stringify(standingRows)]);
    }

    await client.query(
      `insert into calendar_meta (id, generated_at, season, source, refreshed_by, event_count)
       values (true, $1, $2, $3, $4, $5)
       on conflict (id) do update set
         generated_at = excluded.generated_at,
         season       = excluded.season,
         source       = excluded.source,
         refreshed_by = excluded.refreshed_by,
         event_count  = excluded.event_count`,
      [
        stamp(payload.generatedAt) || new Date().toISOString(),
        payload.season || "",
        payload.source || "",
        source,
        events.length,
      ]
    );

    await client.query(
      `insert into refresh_runs (source, status, event_count, duration_ms, finished_at)
       values ($1, 'ok', $2, $3, now())`,
      [source, events.length, Date.now() - startedAt]
    );

    return { events: events.length, standings: standingRows.length, durationMs: Date.now() - startedAt };
  }
}

/** Swap the stored calendar for `payload` and keep it. */
export async function writeSnapshot(pool, payload, { source = "unknown" } = {}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await applySnapshot(client, payload, { source });
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Prove the round trip is lossless without changing anything: write the
 * payload, read it back, then roll the whole thing back. `npm run db:verify`
 * uses this so it can never roll a fresh cron refresh back to a stale local
 * build.
 */
export async function verifyRoundTrip(pool, payload, { source = "verify" } = {}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await applySnapshot(client, payload, { source });
    const stored = await readSnapshot(client);
    return { result, stored };
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

export async function recordFailure(pool, source, err) {
  await pool
    .query(
      `insert into refresh_runs (source, status, error, finished_at)
       values ($1, 'failed', $2, now())`,
      [source, String(err && err.message ? err.message : err).slice(0, 1000)]
    )
    .catch(() => {});
}

/* ------------------------------------------------------------------ reading */

/**
 * Rebuild the `data/calendar.json` payload from Postgres.
 *
 * Queries run one at a time: this is also called with a single checked-out
 * client (inside the verify transaction), where pg rejects overlapping queries.
 * The result is cached upstream, so five sequential round trips cost nothing
 * per page load.
 */
export async function readSnapshot(pool) {
  const meta = await pool.query("select generated_at, season, source from calendar_meta where id");
  const categories = await pool.query("select doc from categories order by ordinal");
  const clubs = await pool.query("select doc from clubs order by ordinal");
  const events = await pool.query("select doc from events order by ordinal");
  const standings = await pool.query("select doc from standings order by ordinal");

  const m = meta.rows[0];
  if (!m) return null;

  return {
    generatedAt: new Date(m.generated_at).toISOString(),
    season: m.season,
    source: m.source,
    categories: categories.rows.map((r) => r.doc),
    clubs: clubs.rows.map((r) => r.doc),
    events: events.rows.map((r) => r.doc),
    standings: standings.rows.map((r) => r.doc),
  };
}

export async function readMeta(pool) {
  const { rows } = await pool.query(
    `select m.generated_at, m.season, m.source, m.refreshed_by, m.event_count,
            (select count(*) from clubs)     as clubs,
            (select count(*) from standings) as leagues,
            (select max(finished_at) from refresh_runs where status = 'ok') as last_success
       from calendar_meta m where m.id`
  );
  return rows[0] || null;
}

export async function readHealth(pool) {
  const { rows } = await pool.query("select 1 as ok");
  return rows[0]?.ok === 1;
}
