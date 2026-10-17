// The scheduled refresh, running next to the database.
//
// Two kinds of tick, and they are deliberately not the same work:
//
//   live — a fixture is in play. Ask ESPN for the scoreboards of the
//          competitions on screen and patch those rows. Two or three HTTP
//          requests, no Wikipedia, no rebuild.
//   full — nothing is live, or the data is more than twelve hours old. Re-run
//          the Wikipedia parse (which also overlays ESPN results) and replace
//          the snapshot.
//
// That split is the point: Wikipedia is a fine source for fixtures, venues,
// referees and league tables, and a poor one for a score at 16:20 on a Saturday.
//
// Callers:
//   1. The 15-minute cron trigger in `neon.ts`, as a signed delivery.
//   2. A human or the Render service, with `Authorization: Bearer $REFRESH_TOKEN`
//      — those always do a full rebuild, because somebody asked for one.
import { parseTriggerDelivery } from "@neon/functions/triggers";

import { buildCalendar } from "../../tools/pipeline.mjs";
import { collectResultPatches } from "../../tools/espn.mjs";
import {
  applyResultPatches,
  getPool,
  lastSuccessAt,
  liveWindow,
  recordFailure,
  writeSnapshot,
} from "../../tools/db.mjs";

const REFRESH_TOKEN = process.env.REFRESH_TOKEN || "";
const SOURCE = "neon-function";

// With nothing in play, rebuild this often at most. This preserves the old
// twice-daily rhythm now that the trigger fires every 15 minutes.
const MAX_AGE_MS = Number(process.env.REFRESH_MAX_AGE_HOURS || 12) * 60 * 60 * 1000;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const isoSecond = (at) => (at ? new Date(at).toISOString() : null);

function toEspnEvent(row) {
  return {
    id: row.id,
    competition: row.competition,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    home: row.home,
    score: row.score,
    date: row.date,
    kickoffUtc: isoSecond(row.kickoff_utc),
  };
}

/** Decide what this tick is for. Two cheap queries. */
async function decide(pool, now) {
  const last = await lastSuccessAt(pool);
  if (!last) return { mode: "full", reason: "never refreshed" };

  const ageMs = now.getTime() - last.getTime();
  if (ageMs >= MAX_AGE_MS) {
    return { mode: "full", reason: `last full refresh ${Math.round(ageMs / 3600000)}h ago` };
  }

  const live = await liveWindow(pool, now);
  if (live.length) {
    const names = live
      .slice(0, 3)
      .map((e) => (e.home_team && e.away_team ? `${e.home_team} v ${e.away_team}` : e.name));
    return { mode: "live", inPlay: live.length, reason: `in play: ${names.join("; ")}` };
  }

  return { mode: "skip", reason: "no match in play" };
}

/** Patch live scores from ESPN. No Wikipedia, no snapshot rewrite. */
async function refreshLive(pool, now) {
  const started = Date.now();
  const rows = await liveWindow(pool, now);
  const { patches, requests } = await collectResultPatches(rows.map(toEspnEvent), {
    now,
    beforeHours: 4,
    afterHours: 4,
  });
  const { updated } = await applyResultPatches(pool, patches);
  return {
    ok: true,
    mode: "live",
    inPlay: rows.length,
    updated,
    requests,
    durationMs: Date.now() - started,
  };
}

/** Full rebuild: Wikipedia parse, ESPN result overlay, whole snapshot replaced. */
async function refreshFull(pool, reason) {
  const lines = [];
  const started = Date.now();
  try {
    const { payload, failed, report } = await buildCalendar({
      force: true,
      log: (line) => lines.push(line),
    });
    const result = await writeSnapshot(pool, payload, {
      source: SOURCE,
      durationMs: Date.now() - started,
    });
    return {
      ok: !failed.f1 && !failed.standings,
      mode: "full",
      reason,
      events: result.events,
      standings: result.standings,
      football: report.counts.football,
      f1: report.counts.f1,
      espnPatched: report.espn.patched,
      generatedAt: payload.generatedAt,
      durationMs: Date.now() - started,
      summary: lines.slice(0, 2).join(" · "),
    };
  } catch (err) {
    await recordFailure(pool, SOURCE, err);
    console.error("refresh failed:", err);
    return { ok: false, mode: "full", reason, error: String(err?.message || err), durationMs: Date.now() - started };
  }
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return json({ ok: true, service: "sports-calendar-refresh", endpoint: "/refresh" });
    }

    // A trigger delivery and a manual call are both POSTs to /refresh; only the
    // delivery carries the x-neon-trigger-invocation-id header.
    const delivery = await parseTriggerDelivery(request).catch(() => ({ ok: false }));
    const manual =
      REFRESH_TOKEN !== "" && request.headers.get("authorization") === `Bearer ${REFRESH_TOKEN}`;

    if (!delivery.ok && !manual) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    const triggeredBy = delivery.ok
      ? `schedule:${delivery.invocation?.trigger?.name || "trigger"}`
      : "manual";

    // An explicit call always rebuilds; a scheduled tick is allowed to decline.
    if (!delivery.ok) {
      const result = await refreshFull(getPool(), "manual");
      return json({ ...result, triggeredBy }, result.ok ? 200 : 500);
    }

    const pool = getPool();
    const decision = await decide(pool, new Date());

    if (decision.mode === "skip") {
      // Worth a log line: on a quiet day this is the only sign the schedule is
      // alive at all.
      console.log("skip", JSON.stringify({ triggeredBy, reason: decision.reason }));
      return json({ ok: true, skipped: true, triggeredBy, reason: decision.reason });
    }

    const result =
      decision.mode === "live"
        ? await refreshLive(pool, new Date())
        : await refreshFull(pool, decision.reason);

    console.log("refresh", JSON.stringify({ ...result, triggeredBy, reason: decision.reason }));
    return json({ ...result, triggeredBy, reason: decision.reason }, result.ok ? 200 : 500);
  },
};
