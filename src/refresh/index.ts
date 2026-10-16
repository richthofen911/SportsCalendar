// The scheduled calendar refresh, running next to the database.
//
// Two callers reach this function:
//
//   1. The cron trigger declared in `neon.ts`. Neon POSTs a signed delivery to
//      `/refresh`; `parseTriggerDelivery` verifies the invocation id.
//   2. A human or the Render service, with `Authorization: Bearer $REFRESH_TOKEN`.
//
// It runs the same pipeline as `npm run refresh` and writes the result to
// Postgres, so the deployment never needs a redeploy to pick up a new matchday.
import { parseTriggerDelivery } from "@neon/functions/triggers";

import { buildCalendar } from "../../tools/pipeline.mjs";
import { getPool, recordFailure, writeSnapshot } from "../../tools/db.mjs";

const REFRESH_TOKEN = process.env.REFRESH_TOKEN || "";
const SOURCE = "neon-function";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function runRefresh(triggeredBy) {
  const lines = [];
  const started = Date.now();
  try {
    const { payload, failed, report } = await buildCalendar({
      force: true,
      log: (line) => lines.push(line),
    });
    const result = await writeSnapshot(getPool(), payload, { source: SOURCE });
    return {
      ok: !failed.f1 && !failed.standings,
      triggeredBy,
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
    return { ok: false, triggeredBy, error: String(err?.message || err), durationMs: Date.now() - started };
  }
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

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

    const result = await runRefresh(triggeredBy);
    console.log(pathname, JSON.stringify(result));
    return json(result, result.ok ? 200 : 500);
  },
};
