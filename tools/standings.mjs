// League tables computed from the season page's own results, which it lists as
// |match_HOME_AWAY=score (380 entries for the Premier League). Wikipedia's
// sports-table module renders the same numbers, so this is a re-derivation of
// the published table rather than a scrape of it.
import { clean } from "./parse.mjs";

export function parseTeamNames(wikitext) {
  const names = {};
  for (const m of wikitext.matchAll(/^[|]\s*name_([^_\s=|]{2,4})[ \t]*=[ \t]*([^\n]*)$/gm)) {
    names[m[1]] = clean(m[2]);
  }
  return names;
}

export function parseRankingCriteria(wikitext) {
  const m = wikitext.match(/[|]\s*ranking_criteria[ \t]*=[ \t]*([^\n]*)/i);
  if (!m) return ["pts", "gd", "gf"];
  return m[1]
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ["pts", "gd", "gf", "head", "abs"].includes(s));
}

// "3–0", "[[rivalry|2–1]]" (played), "[[derby|a]]" (arranged), "" (unscheduled)
export function parseLeagueMatches(wikitext) {
  const out = [];
  const problems = [];
  for (const m of wikitext.matchAll(/^[|]\s*match_([^_\s=|]{2,4})_([^_\s=|]{2,4})[ \t]*=[ \t]*([^\n]*)$/gm)) {
    const [, home, away, raw] = m;
    const text = clean(raw);
    if (!text) {
      out.push({ home, away, state: "unscheduled" });
      continue;
    }
    const score = text.match(/^(\d{1,2})\s*[–-]\s*(\d{1,2})\b/);
    if (score) {
      out.push({ home, away, scoreH: Number(score[1]), scoreA: Number(score[2]), state: "played" });
      continue;
    }
    if (/^a(llocated|rranged)?\.?$/i.test(text) || /\bpostponed\b/i.test(text)) {
      out.push({ home, away, state: /\bpostponed\b/i.test(text) ? "postponed" : "arranged" });
      continue;
    }
    problems.push({ home, away, value: text.slice(0, 60) });
  }
  return { matches: out, problems };
}

export function computeStandings(matches, names, criteria = ["pts", "gd", "gf"]) {
  const table = new Map();
  const row = (code) => {
    if (!table.has(code)) {
      table.set(code, {
        code,
        team: names[code] || code,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        gf: 0,
        ga: 0,
        points: 0,
      });
    }
    return table.get(code);
  };

  for (const m of matches) {
    if (m.state !== "played") continue;
    const h = row(m.home);
    const a = row(m.away);
    h.played++;
    a.played++;
    h.gf += m.scoreH;
    h.ga += m.scoreA;
    a.gf += m.scoreA;
    a.ga += m.scoreH;
    if (m.scoreH > m.scoreA) {
      h.won++;
      a.lost++;
      h.points += 3;
    } else if (m.scoreH < m.scoreA) {
      a.won++;
      h.lost++;
      a.points += 3;
    } else {
      h.drawn++;
      a.drawn++;
      h.points++;
      a.points++;
    }
  }

  const rows = [...table.values()].map((r) => ({ ...r, gd: r.gf - r.ga }));
  const comparators = {
    pts: (x, y) => y.points - x.points,
    gd: (x, y) => y.gd - x.gd,
    gf: (x, y) => y.gf - x.gf,
  };
  // Points always lead; an unrecognised criterion must not silently drop them.
  const chain = [comparators.pts];
  for (const c of criteria) {
    if (c !== "pts" && comparators[c]) chain.push(comparators[c]);
  }
  rows.sort((x, y) => {
    for (const cmp of chain) {
      const d = cmp(x, y);
      if (d) return d;
    }
    return x.team.localeCompare(y.team);
  });
  return rows.map((r, i) => ({ ...r, position: i + 1 }));
}

export function parseUpdated(wikitext) {
  const m = wikitext.match(/[|]\s*update[ \t]*=[ \t]*([^\n]*)/i);
  return m ? clean(m[1]) : null;
}

// Some season pages embed the table; others transclude a "… table" template.
export function findTableTransclusion(wikitext) {
  const m = wikitext.match(/^\{\{\s*([^{}\n|]*?\btable)\s*\}\}\s*$/im);
  return m ? m[1].trim() : null;
}
