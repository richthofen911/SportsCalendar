// The calendar build, as a plain function.
//
// `tools/build.mjs` used to hold both the fetch/parse/generate work and the
// decision to write it to disk. The Neon refresh Function needs the same work
// with a different ending — Postgres instead of files — so the work moved here
// and both callers now share it. Nothing in this module touches the filesystem.
import { CLUBS, CATEGORIES, LEAGUES, clubLogo, leagueLogo } from "./clubs.mjs";
import { collectResultPatches } from "./espn.mjs";
import { fetchWikitext } from "./wiki.mjs";
import { parseSeason, fixtureIdentity, CLUB_ALIASES } from "./parse.mjs";
import { parseF1Calendar, parseF1Results, attachStartTimes } from "./f1.mjs";
import {
  parseLeagueMatches,
  parseTeamNames,
  parseRankingCriteria,
  computeStandings,
  parseUpdated,
  findTableTransclusion,
} from "./standings.mjs";
import { buildIcs } from "./ics.mjs";

export const COMBINED_NAME = "Sports Calendar — everything";
export const COMBINED_FILE = "all-events.ics";

function clubIdForTeamName(name) {
  const key = String(name).toLowerCase();
  for (const club of CLUBS) {
    const aliases = CLUB_ALIASES[club.id] || [];
    if (aliases.some((a) => key === a.toLowerCase())) return club.id;
  }
  for (const club of CLUBS) {
    const aliases = CLUB_ALIASES[club.id] || [];
    if (aliases.some((a) => key.includes(a.toLowerCase()))) return club.id;
  }
  return null;
}

function hash8(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h.toString(36).padStart(7, "0");
}

// UIDs must stay stable between refreshes, so derive them from the fixture
// itself. Some pages reuse one report URL for a whole matchday, hence the
// date/opponent salt and the final uniqueness pass.
function makeIdFactory() {
  const used = new Set();
  return (match) => {
    const urlId = match.report && match.report.match(/\/(?:match|game)\/(\d+)/)?.[1];
    const salt = hash8(`${match.date}|${match.homeTeam}|${match.awayTeam}`);
    let id = urlId ? `${match.club}-${urlId}-${salt}` : `${match.club}-w${salt}`;
    let n = 2;
    while (used.has(id)) id = `${match.club}-w${salt}-${n++}`;
    used.add(id);
    return id;
  };
}

function statusOf(match, now) {
  if (match.score) return "played";
  if (match.kickoffUtc) {
    return new Date(match.kickoffUtc).getTime() < now.getTime() ? "unknown-result" : "upcoming";
  }
  return match.date && match.date < now.toISOString().slice(0, 10)
    ? "unknown-result"
    : "upcoming";
}

/**
 * Turn the calendar into the `.ics` files the site offers.
 * Split out from the fetch so the web server can rebuild them from Postgres
 * without re-running the build.
 */
export function calendarFiles(payload) {
  const events = payload.events || [];
  const football = events.filter((e) => e.category !== "formula-1");
  const f1Events = events.filter((e) => e.category === "formula-1");

  // A tie between two tracked clubs is one calendar entry, not two.
  //
  // `payload.events` arrives in one canonical order from either caller — the
  // builder sorts by kick-off instant, and Postgres stores that position in
  // `events.ordinal` and reads it back — so this stable sort by date yields the
  // same combined file whichever path produced the payload. (VEVENT order
  // carries no meaning in iCalendar; this only keeps the output reproducible.)
  const combined = [];
  const byFixture = new Map();
  for (const m of football) {
    const prev = byFixture.get(m.fixtureKey);
    if (prev) {
      prev.trackedClubs.push(m.club);
      prev.trackedClubNames.push(m.clubName);
      continue;
    }
    const row = { ...m, trackedClubs: [m.club], trackedClubNames: [m.clubName] };
    byFixture.set(m.fixtureKey, row);
    combined.push(row);
  }
  combined.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const generatedAt = payload.generatedAt;
  const files = [
    { key: "all-events", file: COMBINED_FILE, name: COMBINED_NAME, matches: combined },
    { key: "formula-1", file: "formula-1.ics", name: "Formula 1", season: "2026", matches: f1Events },
    ...(payload.clubs || []).map((club) => ({
      key: club.id,
      file: `${club.id}.ics`,
      name: club.name,
      matches: football.filter((m) => m.club === club.id),
    })),
  ];

  return files.map((f) => ({ ...f, content: buildIcs({ ...f, generatedAt }) }));
}

/**
 * The ICS self-check: folding, timestamps, and UID uniqueness. Operates on the
 * generated text so it works in a Function with no filesystem.
 */
export function checkIcsFiles(files) {
  const problems = [];
  const uids = new Map();
  for (const f of files) {
    const raw = f.content;
    const lines = raw.split("\r\n");
    if (!raw.endsWith("\r\n")) problems.push(`${f.name}: missing final CRLF`);
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > 75 && !line.startsWith(" ")) {
        problems.push(`${f.name}: unfolded line of ${Buffer.byteLength(line)} octets`);
        break;
      }
    }
    if (raw.match(/^DTSTART:(?!\d{8}T\d{6}Z)/m)) problems.push(`${f.name}: malformed DTSTART`);
    if ((raw.match(/BEGIN:VEVENT/g) || []).length !== (raw.match(/END:VEVENT/g) || []).length) {
      problems.push(`${f.name}: unbalanced VEVENT`);
    }
    for (const uid of raw.match(/^UID:(.+)/gm) || []) {
      const seenIn = uids.get(uid) || new Set();
      seenIn.add(f.name);
      uids.set(uid, seenIn);
    }
  }
  // UIDs may repeat only between the combined file and its per-club sources.
  for (const [uid, names] of uids) {
    if (names.size > 2) problems.push(`uid ${uid} reused across ${[...names].join(", ")}`);
    if (names.size === 2 && ![...names].includes(COMBINED_NAME)) {
      problems.push(`uid ${uid} duplicated in ${[...names].join(", ")}`);
    }
  }
  return problems;
}

/**
 * Fetch, parse and assemble the whole calendar.
 * Returns the payload, the `.ics` files, and the build report — writes nothing.
 */
export async function buildCalendar({
  force = false,
  now = new Date(),
  log = console.log,
  retentionMonths = Number(process.env.RETENTION_MONTHS || 6),
} = {}) {
  const idOf = makeIdFactory();
  const all = [];
  const report = { skipped: [], duplicates: [], noDate: [], byClub: {} };
  const failed = { f1: false, standings: false };

  for (const club of CLUBS) {
    const entry = await fetchWikitext({ page: club.page, force });
    const { matches, skipped } = parseSeason(entry.wikitext, club);
    report.skipped.push(...skipped.map((s) => ({ club: club.id, ...s })));

    const seen = new Map();
    for (const m of matches) {
      if (!m.date) {
        report.noDate.push({ club: club.id, competition: m.competition, opponent: m.opponent });
        continue;
      }
      const key = `${m.competition}|${m.round}|${m.opponent}|${m.date}`;
      if (seen.has(key)) {
        report.duplicates.push({ club: club.id, key });
        continue;
      }
      seen.set(key, true);
      const full = {
        ...m,
        category: "football",
        clubName: club.name,
        id: idOf(m),
        status: statusOf(m, now),
        fixtureKey: fixtureIdentity(m),
        sourcePage: entry.title,
      };
      all.push(full);
    }

    const played = all.filter((m) => m.club === club.id && m.status === "played").length;
    const upcoming = all.filter((m) => m.club === club.id && m.status === "upcoming").length;
    const odd = all.filter((m) => m.club === club.id && m.status === "unknown-result").length;
    report.byClub[club.id] = {
      total: seen.size,
      played,
      upcoming,
      unknownResult: odd,
      comps: [...new Set(all.filter((m) => m.club === club.id).map((m) => m.competition))],
    };
    log(
      `${club.name.padEnd(22)} total=${String(seen.size).padStart(3)} played=${String(played).padStart(2)} upcoming=${String(upcoming).padStart(2)} unknown=${odd}`
    );
  }

  /* ---------------------------------------------------------------- Formula 1 */

  const f1Category = CATEGORIES.find((c) => c.id === "formula-1");
  const f1Events = [];
  const f1Report = { unmatchedF1: [], extraEspn: [], dateSpread: [] };
  try {
    const page = await fetchWikitext({ page: f1Category.page, force });
    const calendar = parseF1Calendar(page.wikitext, f1Category.year);
    const results = parseF1Results(page.wikitext);
    const espnUrl =
      "https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard?dates=" + f1Category.year;
    const espnBody = await (
      await fetch(espnUrl, { headers: { "User-Agent": "SportsCalendar/1.0" } })
    ).json();
    const espnEvents = (espnBody.events || []).map((e) => ({
      name: e.name,
      date: e.date,
      end: e.endDate,
      state: e.status?.type?.state,
    }));
    attachStartTimes(calendar, espnEvents, f1Report);
    for (const round of calendar) {
      const extra = results.get(round.round) || {};
      f1Events.push({
        id: `f1-${f1Category.year}-${String(round.round).padStart(2, "0")}`,
        category: "formula-1",
        kind: "race",
        round: round.round,
        name: round.name,
        circuit: round.circuit,
        location: round.location,
        country: round.country,
        date: round.date,
        kickoffUtc: round.kickoffUtc || null,
        weekendStartUtc: round.weekendStartUtc || null,
        timeConfidence: round.kickoffUtc ? "exact" : "none",
        status: round.status || "upcoming",
        winner: extra.winner || null,
        winningConstructor: extra.winningConstructor || null,
        pole: extra.pole || null,
        fastestLap: extra.fastestLap || null,
        report: extra.report || null,
        sourcePage: page.title,
      });
    }
  } catch (err) {
    console.error("F1 stage failed:", err.message);
    failed.f1 = true;
  }

  /* ---------------------------------------------------------------- standings */

  const standings = [];
  const standingsReport = { problems: [], orphanCodes: [] };
  for (const league of LEAGUES) {
    try {
      const season = await fetchWikitext({ page: league.page, force });
      let wikitext = season.wikitext;
      let sourcePage = season.title;
      const transclusion = findTableTransclusion(wikitext);
      if (transclusion) {
        const tpl = await fetchWikitext({ page: `Template:${transclusion}`, force });
        wikitext = tpl.wikitext;
        sourcePage = tpl.title;
      }
      const names = parseTeamNames(wikitext);
      const { matches, problems } = parseLeagueMatches(wikitext);
      standingsReport.problems.push(...problems.map((p) => ({ league: league.name, ...p })));
      const codes = new Set(Object.keys(names));
      const used = new Set();
      for (const m of matches) {
        used.add(m.home);
        used.add(m.away);
      }
      const orphans = [...used].filter((c) => !codes.has(c));
      if (orphans.length) standingsReport.orphanCodes.push({ league: league.name, orphans });
      const rows = computeStandings(matches, names, parseRankingCriteria(wikitext)).map((r) => ({
        ...r,
        clubId: clubIdForTeamName(r.team) || null,
      }));
      standings.push({
        category: "football",
        league: league.name,
        leagueId: league.id,
        // The path, not the picture: the image is downloaded by the build
        // (tools/logos.mjs). This module stays free of the filesystem so the
        // Neon Function can run it.
        logo: leagueLogo(league.id),
        updated: parseUpdated(wikitext),
        sourcePage,
        teams: rows.length,
        played: matches.filter((m) => m.state === "played").length,
        rows,
      });
      log(
        `${league.name.padEnd(16)} teams=${String(rows.length).padStart(2)} played=${String(matches.filter((m) => m.state === "played").length).padStart(3)} leader=${rows[0]?.team}`
      );
    } catch (err) {
      console.error(`standings for ${league.name} failed:`, err.message);
      failed.standings = true;
    }
  }

  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const generatedAt = now.toISOString();

  const assembled = [...all, ...f1Events].sort((a, b) => {
    const ka = a.kickoffUtc || `${a.date} 99:99`;
    const kb = b.kickoffUtc || `${b.date} 99:99`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // The calendar is a live schedule, not an archive. Each full rebuild replaces
  // the whole snapshot, so dropping anything that finished more than
  // `retentionMonths` ago is enough to stop the database and the published files
  // growing without bound — there is no separate cleanup job to forget.
  //
  // Only the past is trimmed: future fixtures are the calendar. The window rolls,
  // so from mid-season it also starts dropping the earliest matches of the
  // season; set RETENTION_MONTHS higher (or the same via neon.ts) to keep more.
  const retentionFloor =
    Number.isFinite(retentionMonths) && retentionMonths > 0
      ? (() => {
          const cutoff = new Date(now);
          cutoff.setUTCMonth(cutoff.getUTCMonth() - retentionMonths);
          return cutoff.toISOString().slice(0, 10);
        })()
      : null;

  const events = retentionFloor ? assembled.filter((e) => !e.date || e.date >= retentionFloor) : assembled;
  const pruned = assembled.length - events.length;

  // ESPN owns the result, Wikipedia owns the fixture. A rebuilt calendar must
  // not overwrite a score ESPN already published with a page that has not been
  // edited yet, so the same overlay the live tick uses is applied here.
  const espnReport = { patched: 0, live: 0, requests: 0 };
  try {
    const { patches, requests } = await collectResultPatches(events, {
      now,
      beforeHours: 72,
      afterHours: 6,
      log,
    });
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const { id, patch } of patches) {
      const event = byId.get(id);
      if (!event) continue;
      const { liveMinute, ...rest } = patch;
      Object.assign(event, rest);
      // A finished match must not carry a stale clock.
      if (liveMinute) event.liveMinute = liveMinute;
      else delete event.liveMinute;
      espnReport.patched++;
      if (patch.status === "live") espnReport.live++;
    }
    espnReport.requests = requests;
  } catch (err) {
    // A failed lookup leaves the Wikipedia result in place, which is exactly
    // where this started; it must not fail the whole build.
    console.error("ESPN results unavailable:", err.message);
  }

  const payload = {
    generatedAt,
    season: "2026-27",
    source: "Wikipedia season pages and league table templates; results and F1 start times from ESPN",
    categories: CATEGORIES.map((c) => ({ ...c })),
    clubs: CLUBS.map(({ id, name, short, color, page }) => ({
      id,
      name,
      short,
      color,
      page,
      logo: clubLogo(id),
      aliases: CLUB_ALIASES[id] || [name],
    })),
    events,
    standings,
  };

  const files = calendarFiles(payload);
  const combinedCount = files.find((f) => f.key === "all-events").matches.length;

  const timeConfidence = {};
  for (const m of all) timeConfidence[m.timeConfidence] = (timeConfidence[m.timeConfidence] || 0) + 1;

  const comps = {};
  for (const m of all) comps[m.competition] = (comps[m.competition] || 0) + 1;

  return {
    payload,
    files,
    failed,
    report: {
      generatedAt,
      report,
      timeConfidence,
      comps,
      f1Report,
      standingsReport,
      espn: espnReport,
      retention: { months: retentionMonths, floor: retentionFloor, pruned },
      counts: {
        football: all.length,
        f1: f1Events.length,
        standings: standings.length,
        icsFiles: files.length,
        combined: combinedCount,
        merged: all.length - combinedCount,
      },
    },
  };
}
