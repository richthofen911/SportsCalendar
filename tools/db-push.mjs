// CLI: move the calendar between this machine and Neon.
//
//   npm run db:push      load data/calendar.json into Postgres
//   npm run db:pull      write Postgres back out to data/ and calendar/
//   npm run db:verify    prove the round trip returns the same payload
//   npm run db:status    print what the database currently holds
//
// `db:push` writes the snapshot the build produced. Pass `--refresh` to run the
// Wikipedia fetch first, which is what a from-scratch setup wants.
//
// `db:pull` is the other direction, and the one that matters once the Neon
// Function's cron is running: the database is then the freshest copy, and this
// brings `data/` and `calendar/` — what GitHub Pages and a double-clicked
// index.html serve — back in line with it.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildCalendar, calendarFiles, checkIcsFiles } from "./pipeline.mjs";
import { writeSiteFiles } from "./site-files.mjs";
import {
  connectDirect,
  ensureSchema,
  readMeta,
  readSnapshot,
  verifyRoundTrip,
  writeSnapshot,
} from "./db.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const command = process.argv[2] || "push";
const refresh = process.argv.includes("--refresh");

/** Compare JSON structurally: jsonb does not preserve object key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function firstDifference(a, b, where = "$") {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${where}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const found = firstDifference(a[i], b[i], `${where}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const found = firstDifference(a[k], b[k], `${where}.${k}`);
      if (found) return found;
    }
    return null;
  }
  if (canonical(a) !== canonical(b)) {
    return `${where}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  return null;
}

async function loadPayload() {
  if (refresh) {
    console.log("Running the Wikipedia fetch first (--refresh)…");
    const { payload } = await buildCalendar({ force: true });
    return payload;
  }
  const file = path.join(ROOT, "data", "calendar.json");
  return JSON.parse(await readFile(file, "utf8"));
}

const pool = await connectDirect();
try {
  if (command === "status") {
    const meta = await readMeta(pool);
    if (!meta) {
      console.log("No calendar stored yet. Run `npm run db:push`.");
    } else {
      console.table({
        generatedAt: new Date(meta.generated_at).toISOString(),
        season: meta.season,
        events: meta.event_count,
        clubs: meta.clubs,
        leagues: meta.leagues,
        refreshedBy: meta.refreshed_by,
        lastSuccess: meta.last_success ? new Date(meta.last_success).toISOString() : null,
      });
    }
  } else if (command === "verify") {
    const payload = await loadPayload();
    // Written and read back inside a transaction that is then rolled back, so
    // this proves the round trip without touching what is stored.
    const { stored } = await verifyRoundTrip(pool, payload);
    const difference = stored ? firstDifference(payload, stored) : "no rows returned";
    if (difference) {
      console.error("Round trip DIFFERS at", difference);
      process.exitCode = 1;
    } else {
      console.log(
        `Round trip is faithful: ${stored.events.length} events, ${stored.clubs.length} clubs, ` +
          `${stored.standings.length} league tables, identical after key sorting. ` +
          `(Stored data untouched.)`
      );
    }
  } else if (command === "pull") {
    const payload = await readSnapshot(pool);
    if (!payload) throw new Error("nothing stored yet — run `npm run db:push` first");
    const files = calendarFiles(payload);
    const problems = checkIcsFiles(files);
    if (problems.length) {
      console.error("Refusing to write: the rebuilt .ics files failed their self-check.");
      for (const p of problems.slice(0, 10)) console.error("  ", p);
      process.exitCode = 1;
    } else {
      await writeSiteFiles(ROOT, payload, files);
      console.log(
        `Wrote ${payload.events.length} events and ${files.length} .ics files from Neon ` +
          `(generated ${payload.generatedAt}).`
      );
    }
  } else if (command === "push") {
    const payload = await loadPayload();
    await ensureSchema(pool);
    const result = await writeSnapshot(pool, payload, { source: "cli" });
    console.log(
      `Wrote ${result.events} events and ${result.standings} standing rows to Neon in ${result.durationMs} ms.`
    );
  } else {
    console.error(`Unknown command "${command}". Use push, pull, verify or status.`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
