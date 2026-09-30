// Independent checks of data/calendar.json.
//   1. football results, home/away and kick-offs vs ESPN
//   2. computed league tables vs Wikipedia's own rendered tables
//   3. F1 rounds vs ESPN's race start times
// Usage: node tools/verify.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

import { CLUBS, LEAGUES } from "./clubs.mjs";
import { fetchWikitext } from "./wiki.mjs";
import {
  parseLeagueMatches,
  parseTeamNames,
  parseRankingCriteria,
  computeStandings,
  findTableTransclusion,
} from "./standings.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ESPN_IDS = {
  "real-madrid": ["esp.1", 86],
  barcelona: ["esp.1", 83],
  arsenal: ["eng.1", 359],
  "man-city": ["eng.1", 382],
  bayern: ["ger.1", 132],
  psg: ["fra.1", 160],
};
const UA = { "User-Agent": "SportsCalendar/1.0 (fixture verification)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOISE = new Set([
  "fc", "cf", "afc", "ac", "sc", "fk", "sk", "cp", "if", "ca", "club", "de", "the",
  "04", "05", "09", "1899", "1900", "1907", "2004",
]);

function norm(name) {
  return (name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !NOISE.has(t))
    .join(" ");
}

const ALIAS = [
  ["athletic club", "athletic bilbao"],
  ["stade rennais", "rennes"],
  ["real betis", "betis"],
  ["sv elversberg", "elversberg"],
  ["inter milan", "inter"],
  ["olympique marseille", "marseille"],
  ["olympique lyonnais", "lyon"],
  ["1 fc heidenheim", "heidenheim"],
  ["borussia monchengladbach", "monchengladbach"],
  ["bayer 04 leverkusen", "leverkusen"],
  ["manchester united", "man united"],
];

function sameTeam(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return ALIAS.some((g) => g.includes(x) && g.includes(y));
}

// Ligue 1 has both Paris FC and Paris Saint-Germain, so containment alone can
// pair the wrong pair of clubs. Try exact names first, then aliases, and only
// then fall back to containment.
function pickByTeam(rows, name, teamOf) {
  const target = norm(name);
  return (
    rows.find((r) => norm(teamOf(r)) === target) ||
    rows.find((r) => ALIAS.some((g) => g.includes(target) && g.includes(norm(teamOf(r))))) ||
    rows.find((r) => sameTeam(teamOf(r), name)) ||
    null
  );
}

const data = JSON.parse(readFileSync(path.join(ROOT, "data/calendar.json"), "utf8"));
const football = data.events.filter((e) => e.category === "football");
const races = data.events.filter((e) => e.category === "formula-1");
let failures = 0;

/* ----------------------------------------------------- 1. football vs ESPN */
{
  let checked = 0;
  const bad = [];
  for (const club of CLUBS) {
    const [league, id] = ESPN_IDS[club.id];
    for (const url of [`${league}/teams/${id}/schedule?limit=30`, `${league}/scoreboard`]) {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${url}`, { headers: UA });
      if (!res.ok) continue;
      const body = await res.json();
      for (const e of body.events || []) {
        const c = e.competitions?.[0];
        const home = c?.competitors?.find((x) => x.homeAway === "home");
        const away = c?.competitors?.find((x) => x.homeAway === "away");
        if (!home || !away) continue;
        if (!sameTeam(home.team.displayName, club.name) && !sameTeam(away.team.displayName, club.name)) continue;
        const clubHome = sameTeam(home.team.displayName, club.name);
        const day = (e.date || "").slice(0, 10);
        const opponent = clubHome ? away.team.displayName : home.team.displayName;
        const ours = football.filter(
          (m) => m.club === club.id && m.date === day && sameTeam(m.opponent, opponent)
        );
        if (ours.length > 1) bad.push(`${club.id} ${day}: ${ours.length} rows claim the same fixture`);
        checked++;
        if (!ours.length) {
          bad.push(`${club.id} ${day} ${away.team.displayName} @ ${home.team.displayName}: not in our data`);
          continue;
        }
        const m = ours[0];
        if (m.home !== clubHome) {
          bad.push(`${club.id} ${day}: ground ours=${m.home ? "H" : "A"} espn=${clubHome ? "H" : "A"}`);
        }
        if (c.status?.type?.state === "post" && m.score) {
          const espnScore = clubHome
            ? `${home.score?.value}-${away.score?.value}`
            : `${away.score?.value}-${home.score?.value}`;
          const [hg, ag] = m.score.split("-");
          const mine = m.home ? `${hg}-${ag}` : `${ag}-${hg}`;
          if (mine !== espnScore) bad.push(`${club.id} ${day}: score ours=${mine} espn=${espnScore}`);
        }
        if (m.kickoffUtc && e.date) {
          const espnAt = e.date.endsWith("Z") ? e.date : `${e.date}Z`;
          const gap = Math.abs(Date.parse(m.kickoffUtc) - Date.parse(espnAt)) / 60000;
          if (gap > 120) bad.push(`${club.id} ${day}: kick-off ours=${m.kickoffUtc} espn=${espnAt}`);
        }
      }
      await sleep(250);
    }
  }
  failures += bad.length;
  console.log(`1. football vs ESPN — ${checked} rows checked, ${bad.length} discrepancies`);
  for (const b of bad.slice(0, 10)) console.log("   ✗", b);
}

/* ---------------------------- 2. computed tables vs Wikipedia's rendered */
{
  const strip = (h) =>
    h.replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#\d+;/g, "")
      .replace(/\s+/g, " ")
      .trim();
  for (const league of LEAGUES) {
    const season = await fetchWikitext({ page: league.page });
    let wikitext = season.wikitext;
    let renderPage = league.page;
    const transclusion = findTableTransclusion(wikitext);
    if (transclusion) {
      wikitext = (await fetchWikitext({ page: `Template:${transclusion}` })).wikitext;
      renderPage = `Template:${transclusion}`;
    }
    const mine = computeStandings(
      parseLeagueMatches(wikitext).matches,
      parseTeamNames(wikitext),
      parseRankingCriteria(wikitext)
    );
    const url =
      "https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2&prop=text&page=" +
      encodeURIComponent(renderPage);
    const body = await (await fetch(url, { headers: UA })).json();
    const html = body.parse?.text || "";
    const table =
      (html.match(/<table[\s\S]*?<\/table>/g) || []).find((t) => /Pld/.test(t) && /Pts/.test(t)) || "";
    const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((m) => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => strip(c[1])))
      .filter((r) => r.length >= 9);
    const rendered = rows
      .slice(1)
      .map((r) => ({ pos: +r[0], team: r[1], pld: +r[2], gf: +r[6], ga: +r[7], pts: +r[9] }))
      .filter((r) => r.team && Number.isFinite(r.pts));
    const bad = [];
    for (const r of rendered) {
      const m = pickByTeam(mine, r.team, (x) => x.team);
      if (!m) {
        bad.push(`no computed row for ${r.team}`);
        continue;
      }
      if (m.position !== r.pos || m.played !== r.pld || m.gf !== r.gf || m.ga !== r.ga || m.points !== r.pts) {
        bad.push(
          `${r.team}: computed pos ${m.position} ${m.played}P ${m.gf}:${m.ga} ${m.points}pts vs rendered pos ${r.pos} ${r.pld}P ${r.gf}:${r.ga} ${r.pts}pts`
        );
      }
    }
    failures += bad.length;
    console.log(
      `2. ${league.name} — ${rendered.length} rendered rows vs ${mine.length} computed, ${bad.length} discrepancies`
    );
    for (const b of bad.slice(0, 6)) console.log("   ✗", b);
    await sleep(300);
  }
}

/* ----------------------------------------------------------- 3. F1 vs ESPN */
{
  const url = "https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard?dates=2026";
  const body = await (await fetch(url, { headers: UA })).json();
  const espnEvents = body.events || [];
  let checked = 0;
  const bad = [];
  for (const race of races) {
    const word = race.name.replace(/\s*Grand Prix.*$/i, "").split(/\s+/).pop().toLowerCase();
    const byDate = espnEvents.find(
      (e) => e.endDate && race.kickoffUtc && e.endDate.slice(0, 16) === race.kickoffUtc.slice(0, 16)
    );
    const byName = espnEvents.find((e) => e.endDate && String(e.name).toLowerCase().includes(word));
    const hit = byDate || byName;
    if (!hit) {
      bad.push(`round ${race.round} ${race.name}: nothing on ESPN near ${race.kickoffUtc || race.date}`);
      continue;
    }
    checked++;
    if (race.kickoffUtc && hit.endDate.slice(0, 16) !== race.kickoffUtc.slice(0, 16)) {
      bad.push(`round ${race.round} ${race.name}: ours=${race.kickoffUtc} espn=${hit.endDate}`);
    }
    const espnDone = hit.status?.type?.state === "post";
    if (espnDone !== (race.status === "played")) {
      bad.push(`round ${race.round} ${race.name}: status ours=${race.status} espn=${hit.status?.type?.state}`);
    }
  }
  failures += bad.length;
  console.log(`3. Formula 1 — ${checked}/${races.length} rounds matched, ${bad.length} discrepancies`);
  for (const b of bad.slice(0, 6)) console.log("   ✗", b);
}

console.log(failures ? `\nFAILED: ${failures} problem(s)` : "\nAll checks agree.");
process.exitCode = failures ? 1 : 0;
