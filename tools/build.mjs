import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CLUBS, CATEGORIES, LEAGUES } from "./clubs.mjs";
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

const ROOT = path.resolve(import.meta.dirname, "..");
const force = process.argv.includes("--force");

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

const now = new Date();
const idOf = makeIdFactory();
const all = [];
const report = { skipped: [], duplicates: [], noDate: [], byClub: {} };

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
  console.log(
    `${club.name.padEnd(22)} total=${String(seen.size).padStart(3)} played=${String(played).padStart(2)} upcoming=${String(upcoming).padStart(2)} unknown=${odd}`
  );
}

/* ------------------------------------------------------------------ Formula 1 */

const f1Category = CATEGORIES.find((c) => c.id === "formula-1");
const f1Events = [];
const f1Report = { unmatchedF1: [], extraEspn: [], dateSpread: [] };
try {
  const page = await fetchWikitext({ page: f1Category.page, force });
  const calendar = parseF1Calendar(page.wikitext, f1Category.year);
  const results = parseF1Results(page.wikitext);
  const espnUrl =
    "https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard?dates=" + f1Category.year;
  const espnBody = await (await fetch(espnUrl, { headers: { "User-Agent": "SportsCalendar/1.0" } })).json();
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
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ standings */

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
      updated: parseUpdated(wikitext),
      sourcePage,
      teams: rows.length,
      played: matches.filter((m) => m.state === "played").length,
      rows,
    });
    console.log(
      `${league.name.padEnd(16)} teams=${String(rows.length).padStart(2)} played=${String(matches.filter((m) => m.state === "played").length).padStart(3)} leader=${rows[0]?.team}`
    );
  } catch (err) {
    console.error(`standings for ${league.name} failed:`, err.message);
    process.exitCode = 1;
  }
}

all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

const dataDir = path.join(ROOT, "data");
const calDir = path.join(ROOT, "calendar");
await mkdir(dataDir, { recursive: true });
await mkdir(calDir, { recursive: true });

const generatedAt = now.toISOString();

const events = [...all, ...f1Events].sort((a, b) => {
  const ka = a.kickoffUtc || `${a.date} 99:99`;
  const kb = b.kickoffUtc || `${b.date} 99:99`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
});

const payload = {
  generatedAt,
  season: "2026-27",
  source: "Wikipedia season pages and league table templates; F1 start times from ESPN",
  categories: CATEGORIES.map((c) => ({ ...c })),
  clubs: CLUBS.map(({ id, name, short, color, page }) => ({
      id,
      name,
      short,
      color,
      page,
      aliases: CLUB_ALIASES[id] || [name],
    })),
  events,
  standings,
};

await writeFile(path.join(dataDir, "calendar.json"), JSON.stringify(payload, null, 2));
await writeFile(
  path.join(dataDir, "calendar.js"),
  `// Generated by \`npm run refresh\` at ${generatedAt}\nwindow.CALENDAR_DATA = ${JSON.stringify(payload)};\n`
);

const perClub = CLUBS.map((club) => ({
  club,
  file: path.join(calDir, `${club.id}.ics`),
  matches: all.filter((m) => m.club === club.id),
}));

// A tie between two tracked clubs is one calendar entry, not two.
const combined = [];
const byFixture = new Map();
for (const m of all) {
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
console.log(
  `combined calendar: ${combined.length} entries (${all.length - combined.length} shared fixtures merged)`
);

// The combined calendar legitimately repeats every per-club UID; nothing else may.
const COMBINED_NAME = "Sports Calendar — everything";

const files = [
  { file: path.join(calDir, "all-events.ics"), matches: combined, name: COMBINED_NAME },
  {
    file: path.join(calDir, "formula-1.ics"),
    matches: f1Events,
    name: "Formula 1",
    season: "2026",
  },
  ...perClub.map(({ file, matches, club }) => ({ file, matches, name: club.name })),
];
for (const f of files) {
  await writeFile(f.file, buildIcs({ ...f, generatedAt }));
}

const timeConfidence = {};
for (const m of all) timeConfidence[m.timeConfidence] = (timeConfidence[m.timeConfidence] || 0) + 1;

console.log(
  `\nfootball rows: ${all.length}   f1 rounds: ${f1Events.length}   league tables: ${standings.length}   ics files: ${files.length}`
);
console.log("time confidence:", JSON.stringify(timeConfidence));
console.log("skipped blocks:", report.skipped.length);
for (const s of report.skipped.slice(0, 10)) console.log("  ", JSON.stringify(s));
console.log("duplicates:", report.duplicates.length);
console.log("undated:", report.noDate.length);
for (const s of report.noDate.slice(0, 10)) console.log("  ", JSON.stringify(s));

const comps = {};
for (const m of all) comps[m.competition] = (comps[m.competition] || 0) + 1;
console.log("\ncompetitions:");
for (const [k, v] of Object.entries(comps).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}

function checkIcs(files) {
  const problems = [];
  const uids = new Map();
  for (const f of files) {
    const raw = readFileSync(f.file, "utf8");
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

const icsProblems = checkIcs(files);
if (icsProblems.length) {
  console.error("\nICS self-check FAILED:");
  for (const p of icsProblems.slice(0, 20)) console.error("  ", p);
  process.exitCode = 1;
} else {
  console.log("ICS self-check: ok (folding, timestamps, UIDs)");
}

await writeFile(
  path.join(ROOT, ".cache", "report.json"),
  JSON.stringify({ generatedAt, report, timeConfidence, comps, f1Report, standingsReport }, null, 2)
);
if (f1Report.unmatchedF1.length) console.log("F1 rounds without a start time:", f1Report.unmatchedF1.length);
if (f1Report.dateSpread.length) console.log("F1 date disagreements (wiki vs ESPN):", JSON.stringify(f1Report.dateSpread));
if (standingsReport.problems.length) console.log("unparseable league rows:", standingsReport.problems.length);
if (standingsReport.orphanCodes.length) console.log("team codes without a name:", JSON.stringify(standingsReport.orphanCodes));
