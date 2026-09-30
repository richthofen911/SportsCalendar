// Minimal RFC 5545 writer: CRLF, 75-octet folding, text escaping.

const OCTET_LIMIT = 74;

function escapeText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function fold(line) {
  const octets = Buffer.from(line, "utf8");
  if (octets.length <= OCTET_LIMIT) return line;
  const out = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const chSize = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? OCTET_LIMIT : OCTET_LIMIT - 1;
    if (size + chSize > limit) {
      out.push(current);
      current = " " + ch;
      size = 1 + chSize;
    } else {
      current += ch;
      size += chSize;
    }
  }
  if (current) out.push(current);
  return out.join("\r\n");
}

function toIcsStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`unparsable timestamp: ${iso}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function matchSummary(m) {
  if (m.category === "formula-1") {
    return `${m.name} (Formula 1 · Round ${m.round})`;
  }
  return `${m.homeTeam} v ${m.awayTeam} (${m.competition})`;
}

function describe(m) {
  const lines = [];
  if (m.category === "formula-1") {
    lines.push(`Round ${m.round} of the ${m.sourcePage}`);
    if (m.circuit) lines.push(`Circuit: ${[m.circuit, m.location, m.country].filter(Boolean).join(", ")}`);
    if (m.weekendStartUtc) lines.push(`Weekend opens: ${m.weekendStartUtc}`);
    if (m.kickoffUtc) lines.push(`Race start: ${m.kickoffUtc}`);
    else lines.push(`Race day: ${m.date} — start time not confirmed`);
    if (m.winner) {
      lines.push(`Winner: ${m.winner}${m.winningConstructor ? ` (${m.winningConstructor})` : ""}`);
      if (m.pole) lines.push(`Pole position: ${m.pole}`);
      if (m.fastestLap) lines.push(`Fastest lap: ${m.fastestLap}`);
    }
    lines.push("Source: Wikipedia calendar; start times from ESPN");
    return lines.join("\n");
  }
  if (m.trackedClubNames?.length > 1) {
    lines.push(`Tracked clubs in this tie: ${m.trackedClubNames.join(", ")}`);
  }
  lines.push(`Competition: ${m.competition}${m.phase ? ` (${m.phase})` : ""}`);
  if (m.round) lines.push(`Round: ${m.round}`);
  if (m.kickoffUtc) {
    lines.push(`Kick-off: ${m.kickoffUtc}${m.localClock ? ` (venue clock ${m.localClock})` : ""}`);
    if (m.timeConfidence === "assumed") lines.push("Kick-off zone inferred from the venue");
  } else {
    lines.push(`Date: ${m.date} — kick-off time to be confirmed`);
  }
  if (m.score) {
    lines.push(`Result: ${m.homeTeam} ${m.score}${m.scoreExtra ? ` ${m.scoreExtra}` : ""} ${m.awayTeam}`);
  }
  if (m.homeEvents) lines.push(`${m.homeTeam}: ${m.homeEvents}`);
  if (m.awayEvents) lines.push(`${m.awayTeam}: ${m.awayEvents}`);
  if (m.venue) lines.push(`Venue: ${m.venue}${m.location ? `, ${m.location}` : ""}`);
  if (m.attendance) lines.push(`Attendance: ${m.attendance}`);
  if (m.referee) lines.push(`Referee: ${m.referee}`);
  if (m.notes) lines.push(`Note: ${m.notes}`);
  if (m.report) lines.push(`Report: ${m.report}`);
  lines.push(`Source: Wikipedia — ${m.sourcePage}`);
  return lines.join("\n");
}

export function buildIcs({ name, matches, generatedAt, season = "2026-27" }) {
  const stamp = toIcsStamp(generatedAt);
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SportsCalendar//2026-27//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(season ? `${name} ${season}` : name)}`,
    "X-WR-TIMEZONE:UTC",
    `X-WR-CALDESC:${escapeText(`${matches.length} events, refreshed ${generatedAt.slice(0, 10)}`)}`,
  ];

  for (const m of matches) {
    body.push("BEGIN:VEVENT");
    body.push(`UID:${m.id}@sportscalendar.local`);
    body.push(`DTSTAMP:${stamp}`);
    if (m.kickoffUtc) {
      const start = toIcsStamp(m.kickoffUtc);
      const end = toIcsStamp(Date.parse(m.kickoffUtc) + 2 * 3600000);
      body.push(`DTSTART:${start}`);
      body.push(`DTEND:${end}`);
    } else {
      const day = m.date.replace(/-/g, "");
      const next = new Date(`${m.date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      body.push(`DTSTART;VALUE=DATE:${day}`);
      body.push(`DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, "")}`);
    }
    body.push(`SUMMARY:${escapeText(matchSummary(m))}`);
    const place =
      m.category === "formula-1"
        ? [m.circuit, m.location, m.country].filter(Boolean).join(", ")
        : [m.venue, m.location].filter(Boolean).join(", ") || m.opponent;
    body.push(`LOCATION:${escapeText(place)}`);
    body.push(`DESCRIPTION:${escapeText(describe(m))}`);
    const finished = m.status ? m.status === "played" : Boolean(m.score);
    body.push(`STATUS:${finished ? "CONFIRMED" : "TENTATIVE"}`);
    body.push("END:VEVENT");
  }

  body.push("END:VCALENDAR");
  return body.map(fold).join("\r\n") + "\r\n";
}
