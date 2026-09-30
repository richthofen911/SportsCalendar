// 2026 Formula One: rounds come from the Wikipedia season page (clean names,
// circuits, round numbers); precise UTC start times come from ESPN, whose
// soccer endpoints proved unusable but whose racing feed is complete.
import { clean } from "./parse.mjs";

// Flag codes as they appear in the calendar table's Circuit column.
const FLAG_COUNTRY = {
  AUS: "Australia", BHR: "Bahrain", BRA: "Brazil", CHN: "China", ESP: "Spain",
  FIN: "Finland", GBR: "United Kingdom", HUN: "Hungary", ITA: "Italy",
  JPN: "Japan", MEX: "Mexico", MON: "Monaco", MYS: "Malaysia", NED: "Netherlands",
  QAT: "Qatar", SAU: "Saudi Arabia", SIN: "Singapore", UAE: "United Arab Emirates",
  USA: "United States", AZE: "Azerbaijan", BEL: "Belgium", AUT: "Austria",
  CAN: "Canada",
};

// Split a wikitable into rows of cell strings.
export function parseWikitable(markup) {
  const rows = [];
  for (const chunk of markup.split(/\n\|-/)) {
    if (!/\n[|!]/.test(chunk)) continue;
    const cells = [];
    let current = null;
    for (const line of chunk.split("\n")) {
      const m = line.match(/^\s*([|!])\s*(.*)$/);
      if (m) {
        if (current !== null) cells.push(current);
        let rest = m[2];
        // Drop cell attributes like `style="..."` / `data-sort-value="..."`.
        const pipe = splitCellAttrs(rest);
        current = pipe.value;
      } else if (current !== null && line.trim() && !line.startsWith("{|") && !line.startsWith("|+")) {
        current += " " + line;
      }
    }
    if (current !== null) cells.push(current);
    if (cells.length) rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

function splitCellAttrs(text) {
  // A cell may start with `data-sort-value="RUS" nowrap|` before its content;
  // the pipe inside a template or link is not a separator.
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "{" || ch === "[") && text[i + 1] === ch) depth++;
    else if ((ch === "}" || ch === "]") && text[i + 1] === ch) depth--;
    else if (ch === "|" && depth === 0) return { value: text.slice(i + 1) };
  }
  return { value: text };
}

function firstTableWith(markup, needles) {
  const tables = markup.match(/\{\|[\s\S]*?\n\|\}/g) || [];
  for (const t of tables) {
    if (needles.every((n) => t.includes(n))) return t;
  }
  return null;
}

function monthFromText(text) {
  const m = String(text).match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i);
  if (!m) return null;
  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  return { day: Number(m[1]), month: months[m[2].toLowerCase()] };
}

export function parseF1Calendar(wikitext, year) {
  const table = firstTableWith(wikitext, ["Grand Prix", "Circuit", "Race date"]);
  if (!table) throw new Error("F1 calendar table not found");
  const events = [];
  for (const cells of parseWikitable(table)) {
    const [round, gp, circuit, dateText] = cells;
    if (!/^\d+$/.test(clean(round))) continue;
    const when = monthFromText(dateText);
    if (!when) continue;
    const flag = (circuit || "").match(/\{\{\s*flagicon\s*\|\s*([A-Z]{2,3})/i);
    events.push({
      round: Number(clean(round)),
      name: clean(gp).replace(/\s*Grand Prix$/i, "") + " Grand Prix",
      shortName: clean(gp),
      circuit: clean((circuit || "").replace(/\{\{\s*flagicon[^}]*\}\}/gi, " ")).split(",")[0].trim(),
      location: clean(circuit).split(",").slice(1).join(",").trim(),
      country: flag ? FLAG_COUNTRY[flag[1].toUpperCase()] || null : null,
      date: `${year}-${String(when.month).padStart(2, "0")}-${String(when.day).padStart(2, "0")}`,
    });
  }
  events.sort((a, b) => a.round - b.round);
  return events;
}

// The cell reads `[[2026 Italian Grand Prix|Report]]`; clean() would drop the target.
function f1ReportLink(cell) {
  const target = (String(cell || "").match(/\[\[([^|\]]+)/) || [])[1];
  return target ? `https://en.wikipedia.org/wiki/${encodeURIComponent(target.replace(/ /g, "_"))}` : null;
}

export function parseF1Results(wikitext) {
  const table = firstTableWith(wikitext, ["Pole position", "Winning driver", "Winning constructor"]);
  if (!table) return new Map();
  const byRound = new Map();
  for (const cells of parseWikitable(table)) {
    const [round, gp, pole, fastest, driver, constructor, report] = cells;
    if (!/^\s*\d+\s*$/.test(clean(round))) continue;
    byRound.set(Number(clean(round)), {
      pole: clean(pole),
      fastestLap: clean(fastest),
      winner: clean(driver),
      winningConstructor: clean(constructor),
      report: f1ReportLink(report),
    });
  }
  return byRound;
}

// ESPN titles carry sponsors ("Qatar Airways Australian Grand Prix"), so the
// place word is the token immediately before "Grand Prix", not any word.
export function placeToken(name) {
  const m = String(name).match(/([A-Za-z][A-Za-z'-]+)\s+Grand\s+Prix/i);
  return m ? m[1].toLowerCase() : String(name).toLowerCase().trim();
}

// `date` is the first session of the weekend; `endDate` is the race itself.
export function attachStartTimes(events, espnEvents, report) {
  const pool = espnEvents.map((e) => ({ ...e, used: false }));
  for (const ev of events) {
    const token = placeToken(ev.name);
    const wikiAt = Date.parse(`${ev.date}T12:00:00Z`);
    let best = null;
    for (const c of pool) {
      if (c.used || !c.end) continue;
      if (placeToken(c.name) !== token) continue;
      const gap = Math.abs(Date.parse(c.end) - wikiAt);
      if (!best || gap < best.gap) best = { c, gap };
    }
    if (!best || best.gap > 2 * 86400000) {
      report.unmatchedF1.push({ round: ev.round, name: ev.name, date: ev.date });
      continue;
    }
    best.c.used = true;
    ev.kickoffUtc = best.c.end.slice(0, 16) + "Z";
    ev.weekendStartUtc = best.c.date ? best.c.date.slice(0, 16) + "Z" : null;
    ev.status = best.c.state === "post" ? "played" : "upcoming";
    ev.sourceRaceName = best.c.name;
    // A race held in another time zone can land on the next UTC day; more than
    // that means the two sources genuinely disagree.
    const raceDay = best.c.end.slice(0, 10);
    const dayGap = Math.round((Date.parse(`${raceDay}T00:00:00Z`) - Date.parse(`${ev.date}T00:00:00Z`)) / 86400000);
    if (Math.abs(dayGap) > 1) {
      report.dateSpread.push({ round: ev.round, name: ev.name, wiki: ev.date, espn: best.c.end });
    }
  }
  for (const c of pool) {
    if (!c.used) report.extraEspn.push({ name: c.name, race: c.end, weekend: c.date });
  }
  return events;
}
