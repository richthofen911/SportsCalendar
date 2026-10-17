// Live and final football results, from ESPN's public scoreboard.
//
// Wikipedia's season pages are edited by hand, so a score can appear hours after
// full time — sometimes not at all for a day or two. ESPN publishes the score
// while the match is running and again at the whistle, which is what a calendar
// that refreshes every 15 minutes needs.
//
// ESPN stays the *results* source, not the schedule: fixtures, venues, referees,
// kick-off times and the league tables still come from the Wikipedia parse, and
// only the rows ESPN can match get overridden here. A competition ESPN does not
// carry simply keeps what Wikipedia said.
import { norm, sameTeam } from "./teams.mjs";

const API = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const UA = { "User-Agent": "SportsCalendar/1.0 (live results)" };
const PAUSE_MS = 250;

// Every competition this calendar tracks, and the ESPN league it lives in.
// Verified against the API rather than guessed: the three at the end have
// unexpected slugs (esp.super_cup, fra.super_cup, fifa.intercontinental_cup).
export const ESPN_SLUGS = {
  "Premier League": "eng.1",
  "La Liga": "esp.1",
  "Bundesliga": "ger.1",
  "Ligue 1": "fra.1",
  "UEFA Champions League": "uefa.champions",
  "UEFA Super Cup": "uefa.super_cup",
  "FA Cup": "eng.fa",
  "EFL Cup": "eng.league_cup",
  "FA Community Shield": "eng.charity",
  "DFB-Pokal": "ger.dfb_pokal",
  "Franz Beckenbauer Supercup": "ger.super_cup",
  "Coupe de France": "fra.coupe_de_france",
  "Trophée des Champions": "fra.super_cup",
  "Supercopa de España": "esp.super_cup",
  "FIFA Intercontinental Cup": "fifa.intercontinental_cup",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (iso) => (iso || "").slice(0, 10);

// ESPN returns `score` as a plain string on soccer competitors, and as
// `{ value }` elsewhere in its API. Both shapes turn up, so accept both.
function scoreOf(competitor) {
  const score = competitor?.score;
  if (typeof score === "string" && score.trim() !== "") return score;
  if (typeof score === "number") return String(score);
  if (score && typeof score === "object" && score.value != null) return String(score.value);
  return null;
}

/** Kick-off date in UTC, which is the clock ESPN's `dates` filter uses. */
export function utcDay(event) {
  return day(event.kickoffUtc) || day(event.date);
}

/** One competition's fixtures for one UTC day, normalised. */
export async function fetchScoreboard(slug, date) {
  const url = date ? `${API}/${slug}/scoreboard?dates=${date.replace(/-/g, "")}` : `${API}/${slug}/scoreboard`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${slug} ${date}`);
  const body = await res.json();

  return (body.events || [])
    .map((e) => {
      const competition = e.competitions?.[0];
      if (!competition) return null;
      const home = competition.competitors?.find((c) => c.homeAway === "home");
      const away = competition.competitors?.find((c) => c.homeAway === "away");
      if (!home || !away) return null;
      const type = competition.status?.type || {};
      return {
        id: e.id,
        date: day(e.date),
        state: type.state, // "pre" | "in" | "post"
        completed: Boolean(type.completed),
        detail: type.shortDetail || type.detail || "",
        clock: competition.status?.displayClock || "",
        home: { name: home.team?.displayName || "", score: scoreOf(home) },
        away: { name: away.team?.displayName || "", score: scoreOf(away) },
      };
    })
    .filter(Boolean);
}

/**
 * The ESPN fixture that corresponds to one of ours.
 *
 * Both club names have to match, and the date has to line up: an exact UTC day
 * first, then within a day, because a late kick-off can sit on either side of
 * midnight UTC depending on the source.
 */
export function matchEvent(event, results) {
  const target = utcDay(event);
  const candidates = results.filter(
    (r) => sameTeam(r.home.name, event.homeTeam) && sameTeam(r.away.name, event.awayTeam)
  );
  if (!candidates.length) return null;

  // sameTeam falls back to containment, and containment cannot tell Paris FC
  // from Paris Saint-Germain. Both sides have to match before we get here, but
  // when several candidates survive, prefer the one whose names are exact.
  const exactNames = candidates.filter(
    (r) => norm(r.home.name) === norm(event.homeTeam) && norm(r.away.name) === norm(event.awayTeam)
  );
  const pool = exactNames.length ? exactNames : candidates;

  const exactDay = pool.find((r) => r.date === target);
  if (exactDay) return exactDay;

  return pool.find((r) => Math.abs(Date.parse(r.date) - Date.parse(target)) <= 86_400_000) || null;
}

/**
 * What an ESPN fixture should change on ours, or null to leave it alone.
 *
 * Only "in" and "post" carry information Wikipedia cannot be trusted to have
 * yet. A "pre" result is deliberately ignored: ESPN knowing about a fixture says
 * nothing about whether ours is right.
 */
export function resultPatch(result, { home }) {
  if (!result) return null;
  const homeScore = result.home.score;
  const awayScore = result.away.score;
  if (homeScore == null || awayScore == null) return null;

  // Our `score` is always from the tracked club's point of view.
  const score = home ? `${homeScore}-${awayScore}` : `${awayScore}-${homeScore}`;

  if (result.state === "in") {
    return { score, status: "live", liveMinute: result.detail || result.clock || "LIVE" };
  }
  if (result.state === "post") {
    return { score, status: "played", liveMinute: null };
  }
  return null;
}

/**
 * Collect result patches for events near `now`.
 *
 * Only the competitions that actually have a fixture in the window are fetched,
 * and only for the UTC days involved, so a normal tick is one to three requests
 * rather than one per competition in the season.
 */
export async function collectResultPatches(events, { now = new Date(), beforeHours = 3, afterHours = 3, log = () => {} } = {}) {
  const from = now.getTime() - beforeHours * 3600_000;
  const to = now.getTime() + afterHours * 3600_000;

  const inWindow = events.filter((e) => {
    const at = e.kickoffUtc ? Date.parse(e.kickoffUtc) : Date.parse(`${e.date}T12:00:00Z`);
    return Number.isFinite(at) && at >= from && at <= to;
  });
  if (!inWindow.length) return { patches: [], requests: 0 };

  // competition -> set of UTC days
  const wanted = new Map();
  for (const e of inWindow) {
    const slug = ESPN_SLUGS[e.competition];
    if (!slug) continue;
    const d = utcDay(e);
    if (!d) continue;
    if (!wanted.has(slug)) wanted.set(slug, new Set());
    wanted.get(slug).add(d);
  }

  const bySlug = new Map();
  let requests = 0;
  for (const [slug, days] of wanted) {
    const results = [];
    for (const d of days) {
      try {
        results.push(...(await fetchScoreboard(slug, d)));
        requests++;
      } catch (err) {
        log(`espn: ${slug} ${d} failed (${err.message})`);
      }
      await sleep(PAUSE_MS);
    }
    bySlug.set(slug, results);
  }

  const patches = [];
  for (const e of inWindow) {
    const slug = ESPN_SLUGS[e.competition];
    if (!slug) continue;
    const hit = matchEvent(e, bySlug.get(slug) || []);
    const patch = resultPatch(hit, { home: e.home });
    if (patch) patches.push({ id: e.id, patch, matched: hit, event: e });
  }
  return { patches, requests };
}
