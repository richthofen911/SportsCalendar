// Independent check of data/matches.json against ESPN's public feed.
// Usage: node tools/verify.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

import { CLUBS } from "./clubs.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ESPN_IDS = {
  "real-madrid": ["esp.1", 86],
  barcelona: ["esp.1", 83],
  arsenal: ["eng.1", 359],
  "man-city": ["eng.1", 382],
  bayern: ["ger.1", 132],
  psg: ["fra.1", 160],
};

const NOISE = new Set([
  "fc","cf","afc","ac","sc","club","cp","de","the","if","sk","fk","bk","1899","1900","1907","04","05","1",
]);

function norm(name) {
  return (name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NOISE.has(t))
    .join(" ");
}

const ALIAS = [
  ["manchester united", "man united"],
  ["athletic club", "athletic bilbao"],
  ["stade rennais", "rennes"],
  ["real betis", "betis"],
  ["sv elversberg", "elversberg"],
  ["rayo vallecano", "rayo"],
  ["real sociedad", "real sociedad", "rsociedad"],
  ["1 fc heidenheim", "heidenheim"],
  ["borussia monchengladbach", "monchengladbach"],
  ["bayer 04 leverkusen", "leverkusen"],
  ["olympique marseille", "marseille"],
  ["olympique lyonnais", "lyon"],
  ["inter milan", "inter"],
  ["sl benfica", "benfica"],
  ["union berlin", "union"],
];

function sameTeam(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  for (const group of ALIAS) {
    if (group.includes(x) && group.includes(y)) return true;
  }
  const tx = new Set(x.split(" "));
  const ty = new Set(y.split(" "));
  let shared = 0;
  for (const t of tx) if (ty.has(t)) shared++;
  return shared >= 1 && shared === Math.min(tx.size, ty.size);
}

async function espn(pathname) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${pathname}`;
  const res = await fetch(url, { headers: { "User-Agent": "SportsCalendar/1.0" } });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  return res.json();
}

function eventsToRows(body) {
  const rows = [];
  for (const e of body.events || []) {
    const c = e.competitions?.[0];
    if (!c) continue;
    const state = c.status?.type?.state ?? e.status?.type?.state;
    const home = c.competitors?.find((x) => x.homeAway === "home");
    const away = c.competitors?.find((x) => x.homeAway === "away");
    if (!home || !away) continue;
    rows.push({
      kickoff: (e.date || c.date || "").slice(0, 16),
      state,
      home: home.team?.displayName,
      away: away.team?.displayName,
      homeScore: home.score?.value ?? null,
      awayScore: away.score?.value ?? null,
    });
  }
  return rows;
}

const data = JSON.parse(readFileSync(path.join(ROOT, "data/matches.json"), "utf8"));
const ours = data.matches;

let checked = 0;
let mismatches = 0;
const unverified = [];

for (const club of CLUBS) {
  const [league, id] = ESPN_IDS[club.id];
  const rows = eventsToRows(await espn(`${league}/teams/${id}/schedule?limit=30`));
  await new Promise((r) => setTimeout(r, 300));
  const upcoming = eventsToRows(await espn(`${league}/scoreboard`));
  await new Promise((r) => setTimeout(r, 300));

  const candidates = [...rows, ...upcoming].filter(
    (r) => r.home && (sameTeam(r.home, club.name) || sameTeam(r.away, club.name))
  );

  for (const r of candidates) {
    const clubHome = sameTeam(r.home, club.name);
    const opponent = clubHome ? r.away : r.home;
    const day = r.kickoff.slice(0, 10);
    const found = ours.filter(
      (m) => m.club === club.id && m.date === day && sameTeam(m.opponent, opponent)
    );
    checked++;
    if (!found.length) {
      unverified.push(`${club.id} ${day} vs ${opponent}: not in our data`);
      continue;
    }
    const m = found[0];
    const problems = [];
    if (m.home !== clubHome) problems.push(`ground: ours=${m.home ? "home" : "away"} espn=${clubHome ? "home" : "away"}`);
    if (r.state === "post" && m.score) {
      const espn = clubHome ? `${r.homeScore}-${r.awayScore}` : `${r.awayScore}-${r.homeScore}`;
      const [hg, ag] = m.score.split("-").map(Number);
      const ours = m.home ? `${hg}-${ag}` : `${ag}-${hg}`;
      if (ours !== espn) problems.push(`score: ours=${ours} espn=${espn}`);
    }
    if (r.kickoff && m.kickoffUtc && m.kickoffUtc !== r.kickoff + "Z") {
      // ESPN sometimes reports the local slot; only flag hour-level disagreement.
      const diffMin = Math.abs(new Date(m.kickoffUtc) - new Date(r.kickoff + "Z")) / 60000;
      if (diffMin > 120) problems.push(`kick-off: ours=${m.kickoffUtc} espn=${r.kickoff}Z`);
    }
    if (problems.length) {
      mismatches++;
      console.log(`✗ ${club.id} ${day} vs ${opponent} — ${problems.join("; ")}`);
    }
  }
}

console.log(
  `\nESPN rows compared: ${checked}   discrepancies: ${mismatches}   unmatched: ${unverified.length}`
);
for (const u of unverified) console.log("  ?", u);
