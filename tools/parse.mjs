// Turns a club's season-page wikitext into normalised match records.
// Two markup layouts appear in practice: {{football box collapsible}} with
// space-padded keys (Arsenal, Barça, City, Bayern, PSG) and
// {{footballbox collapsible}} without (Real Madrid).

const ALIASES = {
  "real-madrid": ["real madrid"],
  barcelona: ["barcelona", "fc barcelona", "barça"],
  arsenal: ["arsenal", "arsenal fc", "arsenal f.c."],
  "man-city": ["manchester city", "man city", "manchester city fc"],
  bayern: [
    "bayern munich",
    "fc bayern munich",
    "bayern",
    "bayern münchen",
    "fc bayern münchen",
  ],
  psg: [
    "paris saint-germain",
    "paris saint germain",
    "psg",
    "paris saint-germain fc",
  ],
};

// Zone abbreviations used inside time fields.
const ZONE_OFFSETS = {
  utc: 0,
  gmt: 0,
  wet: 0,
  bst: 1,
  west: 1,
  cet: 1,
  mesz: 1,
  cest: 2,
  eet: 2,
  eest: 3,
  azt: 4,
  msk: 3,
  trt: 3,
};

// Time-zone article titles used by the kick-off fields.
const ZONE_ARTICLES = {
  "greenwich mean time": 0,
  "western european time": 0,
  "western european summer time": 1,
  "british summer time": 1,
  "irish standard time": 1,
  "central european time": 1,
  "central european summer time": 2,
  "eastern european time": 2,
  "eastern european summer time": 3,
  "austria time": 1,
  "west african time": 1,
  "north eastern european time": 1,
  "turkey time": 3,
  "azərbaycan time": 4,
  "moscow time": 3,
  "eastern african time": 3,
  "gulf standard time": 4,
  "eastern european time (summer)": 3,
};

// Country named after the city in |location = resolves the venue zone.
const COUNTRY_ZONE = {
  spain: "Europe/Madrid",
  portugal: "Europe/Lisbon",
  england: "Europe/London",
  scotland: "Europe/London",
  wales: "Europe/London",
  "northern ireland": "Europe/London",
  ireland: "Europe/Dublin",
  germany: "Europe/Berlin",
  france: "Europe/Paris",
  italy: "Europe/Rome",
  netherlands: "Europe/Amsterdam",
  belgium: "Europe/Brussels",
  austria: "Europe/Vienna",
  switzerland: "Europe/Zurich",
  denmark: "Europe/Copenhagen",
  sweden: "Europe/Stockholm",
  norway: "Europe/Oslo",
  croatia: "Europe/Zagreb",
  greece: "Europe/Athens",
  turkey: "Europe/Istanbul",
  azerbaijan: "Asia/Baku",
  russia: "Europe/Moscow",
  poland: "Europe/Warsaw",
  czechia: "Europe/Prague",
  "czech republic": "Europe/Prague",
  ukraine: "Europe/Kyiv",
  romania: "Europe/Bucharest",
  hungary: "Europe/Budapest",
  serbia: "Europe/Belgrade",
  argentina: "America/Argentina/Buenos_Aires",
  brazil: "America/Sao_Paulo",
  usa: "America/New_York",
  "united states": "America/New_York",
  mexico: "America/Mexico_City",
  qatar: "Asia/Qatar",
  "saudi arabia": "Asia/Riyadh",
  japan: "Asia/Tokyo",
  korea: "Asia/Seoul",
  morocco: "Africa/Casablanca",
 egypt: "Africa/Cairo",
};

const CLUB_ZONE = {
  "real-madrid": "Europe/Madrid",
  barcelona: "Europe/Madrid",
  arsenal: "Europe/London",
  "man-city": "Europe/London",
  bayern: "Europe/Berlin",
  psg: "Europe/Paris",
};



export const CLUB_ALIASES = ALIASES;

const BOX_RE =
  /\{\{\s*(?:#[Ii]nvoke:\s*)?(?:football\s*box|footballbox)\b(?!\s*list-start)/gi;

function stripRefs(text) {
  let out = text;
  let prev;
  do {
    prev = out;
    out = out.replace(/<ref[^>/]*(?:\s*\/>|\s*>[^<]*<\/ref>)/gis, "");
  } while (out !== prev);
  return out;
}

// Split a template body into |key = value at brace/bracket depth 0.
function splitFields(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" && body[i + 1] === "{") {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === "}" && body[i + 1] === "}") {
      depth--;
      cur += ch;
      continue;
    }
    if (ch === "[" && body[i + 1] === "[") {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === "]" && body[i + 1] === "]") {
      depth--;
      cur += ch;
      continue;
    }
    if (ch === "|" && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);

  const fields = {};
  for (const part of parts) {
    if (!part.trim()) continue;
    const eq = indexOfTopLevel(part, "=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (!/^[a-z0-9_ ]+$/.test(key)) continue;
    fields[key] = value;
  }
  return fields;
}

function indexOfTopLevel(text, needle) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "{" || ch === "[") && text[i + 1] === ch) {
      depth++;
      i++;
      continue;
    }
    if ((ch === "}" || ch === "]") && text[i + 1] === ch) {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch === needle) return i;
  }
  return -1;
}

// Find matching "}}" for a template opened at `open` ("{{").
function closeOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    if (pair === "{{") depth++;
    else if (pair === "}}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Football-box scorer lists mix goals and bookings; keep both, labelled.
const MATCH_EVENT_TPL =
  /\{\{\s*(goal|pen|yyc|yel|yellow\s*card|rdbl|red\s*card|auto|og|o\.g\.)\s*(?:\|\s*([^|}]*))?(?:\s*\|\s*([^|}]*))?(?:\|[^{}]*)?\}\}/gi;

function renderMatchEvent(_m, kind, a, b) {
  const minute = /^\d{1,3}$/.test(String(a ?? "").trim()) ? `${String(a).trim()}'` : "";
  const note = String(b ?? a ?? "")
    .toLowerCase()
    .replace(/[^a-z.]/g, "");
  const k = kind.toLowerCase().replace(/\s+/g, "");
  if (k === "yel" || k === "yyc" || k === "yellowcard") return `${minute} (yellow)`;
  if (k === "rdbl" || k === "redcard") return `${minute} (red)`;
  if (note.includes("pen")) return `${minute} (pen.)`;
  if (note.includes("o.g") || note.includes("own")) return `${minute} (own goal)`;
  return minute;
}

function clean(value) {
  if (!value) return "";
  let out = stripRefs(value);
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<\/?[a-z][^>]*>/gi, " ");
  out = out.replace(/\{\{\s*(fbaicon|flagicon|abbr|small|nowrap|cbb)\b[^{}]*\}\}/gi, " ");
  out = out.replace(MATCH_EVENT_TPL, renderMatchEvent);
  out = out.replace(/\{\{\s*UTZ[^{}]*\}\}/gi, " ");
  out = out.replace(/\{\{[^{}]*\}\}/g, " ");
  out = out.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1");
  out = out.replace(/'''?/g, "");
  out = out.replace(/&nbsp;/g, " ");
  out = out.replace(/&#\d+;/g, "");
  out = out.replace(/&amp;/g, "&");
  out = out.replace(/\*/g, " ");
  out = out.replace(/\s+/g, " ");
  return out.trim();
}

// Scorer lists are bullet lines; keep one entry per bullet.
function parseList(value) {
  if (!value) return "";
  return value
    .split(/\n\s*\*/)
    .map((chunk) => clean(chunk).replace(/^,+|,+$/g, "").trim())
    .filter(Boolean)
    .join(", ");
}

function normTeam(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9 .'-]/g, " ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clubSide(fields, clubId) {
  const aliases = ALIASES[clubId].map((a) => a.replace(/[^a-z0-9 .-]/g, "").replace(/[ .]/g, ""));
  for (const slot of ["team1", "team2"]) {
    const key = normTeam(fields[slot] || "").replace(/[^a-z0-9]/g, "");
    if (!key) continue;
    if (aliases.some((a) => key === a)) return slot;
  }
  for (const slot of ["team1", "team2"]) {
    const key = normTeam(fields[slot] || "").replace(/[^a-z0-9]/g, "");
    if (aliases.some((a) => key.includes(a) || a.includes(key))) return slot;
  }
  return null;
}

function monthNum(name) {
  const m = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  }[String(name).toLowerCase()];
  return m;
}

function parseDate(raw) {
  if (!raw) return null;
  const tpl = raw.match(
    /\{\{\s*(?:Start|End)\s+date\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i
  );
  if (tpl) {
    return `${tpl[1]}-${String(tpl[2]).padStart(2, "0")}-${String(tpl[3]).padStart(2, "0")}`;
  }
  const t = clean(raw);
  let m = t.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
  if (m) {
    const mo = monthNum(m[2]);
    if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  }
  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function offsetForZoneAt(zone, dateStr) {
  if (!dateStr) return null;
  const [y, mo, d] = dateStr.split("-").map(Number);
  const zonedHourFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "hcv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  // Compare wall clock in the zone with UTC for the same instant.
  const base = Date.UTC(y, mo - 1, d, 12, 0, 0);
  const parts = Object.fromEntries(zonedHourFormat.formatToParts(new Date(base)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
  return Math.round((asUtc - base) / 3600000);
}

function venueZone(locationText, dateStr, clubId) {
  const parts = clean(locationText)
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const p of parts) if (COUNTRY_ZONE[p]) return COUNTRY_ZONE[p];
  return CLUB_ZONE[clubId] || "UTC";
}

// Returns { utc: "YYYY-MM-DDTHH:MMZ" | null, confidence, clock }
function parseTime(fields, dateStr, clubId) {
  const raw = fields.time || "";
  if (!raw || !dateStr) return { utc: null, confidence: "none", display: "" };

  const utz = raw.match(
    /\{\{\s*UTZ\s*\|\s*(\d{1,2})\s*:\s*(\d{2})\s*(?:\|\s*(-?\d{1,2}))?(?:\|\s*(-?\d{1,2}))?\s*\}\}/i
  );
  if (utz) {
    const offset = utz[3] === undefined ? null : Number(utz[3]);
    const alt = utz[4] === undefined ? null : Number(utz[4]);
    const off = alt !== null && offset === null ? alt : offset;
    return build(dateStr, Number(utz[1]), Number(utz[2]), off, off === null ? "assumed" : "exact");
  }

  const text = clean(raw);
  const plain = text.match(/(\d{1,2})[:.](\d{2})/);
  if (!plain) return { utc: null, confidence: "none", display: "" };
  const hour = Number(plain[1]);
  const minute = Number(plain[2]);

  // Prefer the linked time-zone article, then a spelled-out UTC offset.
  const article = raw.match(/\[\[([^\]|]+)\|[^\]]*\]\]/g) || [];
  for (const link of article) {
    const title = link.slice(2, -2).split("|")[0].trim().toLowerCase();
    if (title in ZONE_ARTICLES) {
      return build(dateStr, hour, minute, ZONE_ARTICLES[title], "exact");
    }
  }

  const utcToken = raw.match(/UTC\s*([+-])\s*(\d{1,2})(?::(\d{2}))?/i);
  if (utcToken) {
    const off = Number(utcToken[2]) + (Number(utcToken[3] || 0) / 60);
    return build(dateStr, hour, minute, utcToken[1] === "-" ? -off : off, "exact");
  }

  const zoneToken = text.match(/\b(UTC|GMT|BST|CEST|CET|EEST|EET|WEST|WET|AZT|MSK|TRT)\b/);
  if (zoneToken) {
    const off = ZONE_OFFSETS[zoneToken[1].toLowerCase()];
    if (off !== undefined) return build(dateStr, hour, minute, off, "exact");
  }
  const zone = venueZone(fields.location || "", dateStr, clubId);
  return build(dateStr, hour, minute, offsetForZoneAt(zone, dateStr), "assumed");
}

function build(dateStr, hour, minute, offsetHours, confidence) {
  if (offsetHours === null || Number.isNaN(offsetHours)) {
    return { utc: null, confidence: "none", display: `${hour}:${String(minute).padStart(2, "0")}` };
  }
  const utcMs = Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10)),
    hour,
    minute
  ) - offsetHours * 3600000;
  return {
    utc: new Date(utcMs).toISOString().slice(0, 16) + "Z",
    confidence,
    display: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function parseScore(raw) {
  const t = clean(raw).replace(/\s+/g, " ").trim();
  if (!t) return null;
  const m = t.match(/^(\d+)\s*[–\-:]\s*(\d+)/);
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]), display: t.match(/^(\d+\s*[–\-:]\s*\d+)(.*)$/)[2].trim() };
}

function extractBlocks(wikitext) {
  const out = [];
  let m;
  BOX_RE.lastIndex = 0;
  while ((m = BOX_RE.exec(wikitext))) {
    const open = m.index;
    const close = closeOf(wikitext, open);
    if (close === -1) continue;
    const body = wikitext.slice(open + 2, close);
    // The template name and its first param may sit on the opening line.
    const nl = body.indexOf("\n");
    if (nl === -1) continue;
    out.push({ start: open, end: close, fields: splitFields(body) });
    BOX_RE.lastIndex = close + 2;
  }
  return out;
}

// Walk headings so each block inherits its competition.
function sectionMap(wikitext) {
  const headings = [];
  const re = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;
  let m;
  while ((m = re.exec(wikitext))) {
    headings.push({ pos: m.index, level: m[1].length, title: clean(m[2]) });
  }
  return headings;
}

function competitionAt(headings, pos) {
  let competition = null;
  let phase = null;
  let competitionsOpen = false;
  for (const h of headings) {
    if (h.pos > pos) break;
    if (h.level === 2) {
      competitionsOpen = /competitions/i.test(h.title);
      competition = null;
      phase = null;
      continue;
    }
    if (!competitionsOpen) continue;
    if (h.level === 3) {
      competition = h.title;
      phase = null;
    } else if (h.level === 4) {
      phase = h.title;
    }
  }
  return { competition, phase, inCompetitions: competitionsOpen };
}

export function parseSeason(wikitext, club) {
  const headings = sectionMap(wikitext);
  const blocks = extractBlocks(wikitext);
  const matches = [];
  const skipped = [];

  for (const { start, fields } of blocks) {
    const { competition, phase, inCompetitions } = competitionAt(headings, start);
    if (!inCompetitions) continue;
    if (/overall record|transfers|statistics|squad/i.test(competition || "")) continue;

    const dateStr = parseDate(fields.date || fields.date1);
    const side = clubSide(fields, club.id);
    const score = parseScore(fields.score);
    const team1 = clean(fields.team1);
    const team2 = clean(fields.team2);

    if (!side) {
      skipped.push({
        why: "club not found in team1/team2",
        competition,
        date: dateStr,
        team1,
        team2,
      });
      continue;
    }
    const home = side === "team1";
    const opponent = clean(home ? fields.team2 : fields.team1);
    const timeInfo = parseTime(fields, dateStr, club.id);

    matches.push({
      club: club.id,
      competition: competition || "Unknown",
      phase: phase && !/matches|table|summary|by round/i.test(phase) ? phase : null,
      round: clean(fields.round).replace(/^#/, ""),
      date: dateStr,
      kickoffUtc: timeInfo.utc,
      timeConfidence: timeInfo.confidence,
      localClock: timeInfo.display,
      venue: clean(fields.stadium),
      location: clean(fields.location),
      home,
      opponent,
      // Scores are always home-first; the club's own view is derivable
      // from `home` and stays consistent when two tracked clubs merge.
      score: score ? `${score.home}-${score.away}` : null,
      scoreExtra: score ? score.display || "" : clean(fields.score) || null,
      homeTeam: team1,
      awayTeam: team2,
      clubResult: /^[WDLPp]$/.test(clean(fields.result))
        ? clean(fields.result).toUpperCase()
        : null,
      homeEvents: parseList(fields.goals1),
      awayEvents: parseList(fields.goals2),
      notes: clean(fields.note),
      referee: clean(fields.referee),
      attendance: clean(fields.attendance).replace(/,/g, ""),
      report: /^https?:\/\/\S+/.test(clean(fields.report)) ? clean(fields.report) : null,
    });
  }

  return { matches, skipped };
}

const NOISE_TOKENS = new Set([
  "fc", "cf", "afc", "ac", "sc", "fk", "sk", "cp", "if", "ca", "club", "de", "the",
  "04", "05", "09", "1899", "1900", "1907", "2004",
]);

function slugName(name) {
  return (name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !NOISE_TOKENS.has(t))
    .join(" ");
}

export function teamKey(name) {
  return slugName(name);
}

// Two season pages can spell the same fixture differently, so map every
// tracked club to its id before building the identity.
export function resolveTrackedClub(name) {
  const key = slugName(name);
  if (!key) return null;
  for (const [clubId, aliases] of Object.entries(ALIASES)) {
    if (aliases.some((a) => key === slugName(a))) return clubId;
  }
  return null;
}

export function fixtureIdentity(match) {
  const a = resolveTrackedClub(match.homeTeam) || slugName(match.homeTeam);
  const b = resolveTrackedClub(match.awayTeam) || slugName(match.awayTeam);
  return `${match.date}|${[a, b].sort().join("|")}`;
}
