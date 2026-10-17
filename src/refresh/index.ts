// The scheduled calendar refresh, running next to the database.
//
// Three callers reach this function:
//
//   1. The 15-minute cron trigger declared in `neon.ts`. Neon POSTs a signed
//      delivery to `/refresh`; `parseTriggerDelivery` verifies the invocation id.
//      Most ticks do almost nothing — see `decide` — and only a tick with a
//      fixture in play triggers a rebuild.
//   2. A human, or the Render service, with `Authorization: Bearer $REFRESH_TOKEN`.
//      Those always rebuild: somebody asked for it.
//
// It runs the same pipeline as `npm run refresh` and writes the result to
// Postgres, so the deployment never needs a redeploy to pick up a new result.
import { parseTriggerDelivery } from "@neon/functions/triggers";

import { buildCalendar } from "../../tools/pipeline.mjs";
import {
  getPool,
  lastSuccessAt,
  liveWindow,
  recordFailure,
  writeSnapshot,
} from "../../tools/db.mjs";

const REFRESH_TOKEN = process.env.REFRESH_TOKEN || "";
const SOURCE = "neon-function";

// With nothing in play, rebuild this often at most. This is what preserves the
// old twice-daily rhythm now that the trigger fires every 15 minutes.
const MAX_AGE_MS = Number(process.env.REFRESH_MAX_AGE_HOURS || 12) * 60 * 60 * 1000;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Is a rebuild worth doing on this tick?
 *
 * Two cheap queries. A full rebuild is fourteen throttled Wikipedia requests,
 * so it should not happen 96 times a day for nothing — but it should happen
 * every quarter hour while a fixture is in play, which is the whole point.
 */
async function decide(pool, now) {
  const live = await liveWindow(pool, now);
  if (live.length) {
    const names = live
      .slice(0, 3)
      .map((e) => (e.home_team && e.away_team ? `${e.home_team} v ${e.away_team}` : e.name));
    return { run: true, live: live.length, reason: `in play: ${names.join("; ")}` };
  }

  const last = await lastSuccessAt(pool);
  if (!last) return { run: true, live: 0, reason: "never refreshed" };

  const ageMs = now.getTime() - last.getTime();
  if (ageMs >= MAX_AGE_MS) {
    return { run: true, live: 0, reason: `last refresh ${Math.round(ageMs / 3600000)}h ago` };
  }
  return { run: false, live: 0, reason: "no match in play" };
}

async function runRefresh(triggeredBy, reason) {
  const lines = [];
  const started = Date.now();
  try {
    const { payload, failed, report } = await buildCalendar({
      force: true,
      log: (line) => lines.push(line),
    });
    const result = await writeSnapshot(getPool(), payload, {
      source: SOURCE,
      durationMs: Date.now() - started,
    });
    return {
      ok: !failed.f1 && !failed.standings,
      triggeredBy,
      reason,
      events: result.events,
      standings: result.standings,
      football: report.counts.football,
      f1: report.counts.f1,
      generatedAt: payload.generatedAt,
      durationMs: Date.now() - started,
      summary: lines.slice(0, 2).join(" · "),
    };
  } catch (err) {
    await recordFailure(getPool(), SOURCE, err);
    console.error("refresh failed:", err);
    return {
      ok: false,
      triggeredBy,
      reason,
      error: String(err?.message || err),
      durationMs: Date.now() - started,
    };
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

    // A scheduled tick is allowed to do nothing; an explicit call is not.
    let reason = "manual";
    if (delivery.ok) {
      const decision = await decide(getPool(), new Date());
      reason = decision.reason;
      if (!decision.run) {
        // Worth a log line: on a quiet day this is the only sign the schedule
        // is alive at all.
        console.log("skip", JSON.stringify({ triggeredBy, reason }));
        return json({ ok: true, skipped: true, triggeredBy, reason });
      }
    }

    const result = await runRefresh(triggeredBy, reason);
    console.log("refresh", JSON.stringify(result));
    return json(result, result.ok ? 200 : 500);
  },
};
