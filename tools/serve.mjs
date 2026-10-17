// Static server for the LAN and for Render, plus the refresh endpoint.
//
// With `DATABASE_URL` set the calendar is read from Postgres (Neon) and the
// `.ics` files are generated from it, so a refresh lands without redeploying.
// Without it — the double-click-a-file case, or a checkout with no `.env` — the
// server falls back to the committed `data/` and `calendar/` files exactly as
// it always did.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";

import { buildCalendar, calendarFiles } from "./pipeline.mjs";
import {
  databaseUrl,
  getPool,
  readMeta,
  readSnapshot,
  recordFailure,
  writeSnapshot,
} from "./db.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const PORT = Number(arg("port", process.env.PORT || 4173));
const HOST = arg("host", "0.0.0.0");

// Reading the whole calendar on every page load would put ~300 KB of jsonb
// through Postgres each time. A short in-memory copy keeps that to one read per
// window and is dropped the moment a refresh writes new rows.
const SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_TTL_MS || 30_000);
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || "";
const REFRESH_FUNCTION_URL = process.env.REFRESH_FUNCTION_URL || "";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ics": "text/calendar; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function dbEnabled() {
  return Boolean(databaseUrl());
}

// On Render the database is the point: quietly serving the committed files
// instead would look healthy while showing last week's fixtures. The blueprint
// sets REQUIRE_DATABASE=true so a missing DATABASE_URL stops the boot instead.
if (process.env.REQUIRE_DATABASE === "true" && !dbEnabled()) {
  console.error(
    "REQUIRE_DATABASE=true but DATABASE_URL is not set. " +
      "Set it to the pooled Neon connection string (see README, Deploy)."
  );
  process.exit(1);
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

function isPrivateAddress(ip) {
  if (!ip) return false;
  const bare = ip.replace(/^::ffff:/, "");
  return (
    bare === "::1" ||
    bare === "localhost" ||
    /^127\./.test(bare) ||
    /^10\./.test(bare) ||
    /^192\.168\./.test(bare) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(bare) ||
    /^f[cd][0-9a-f]{2}:/i.test(bare) // unique-local IPv6
  );
}

/**
 * The address the request really came from.
 *
 * This deliberately ignores the `Host` header, which any caller can set: a
 * public request that claims `Host: localhost` must not be mistaken for one
 * from the sofa. Behind Render's proxy the socket peer is the proxy itself, so
 * the last `X-Forwarded-For` entry — the hop our own proxy appended — is the
 * client.
 */
function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const hops = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || "";
}

function tokenMatches(header) {
  if (!REFRESH_TOKEN || typeof header !== "string") return false;
  const expected = `Bearer ${REFRESH_TOKEN}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function refreshAuthorised(req) {
  return tokenMatches(req.headers.authorization) || isPrivateAddress(clientAddress(req));
}

/* ------------------------------------------------------------------ snapshot */

let cache = { at: 0, payload: null };

function invalidate() {
  cache = { at: 0, payload: null };
}

async function currentSnapshot() {
  if (!dbEnabled()) return null;
  if (cache.payload && Date.now() - cache.at < SNAPSHOT_TTL_MS) return cache.payload;
  const payload = await readSnapshot(getPool());
  if (!payload) return null;
  cache = { at: Date.now(), payload };
  return payload;
}

async function fileFallback(relPath) {
  return readFile(path.join(ROOT, relPath));
}

/* ------------------------------------------------------------------ refresh */

function runBuildProcess() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "tools", "build.mjs"), "--force"], {
      cwd: ROOT,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ ok: code === 0, code, out, err }));
  });
}

/**
 * Refresh the calendar.
 *
 * In production the work belongs to the Neon Function, which already has the
 * cron trigger: this just calls it, so there is one implementation of the
 * pipeline on the deployed side. Setting `REFRESH_FUNCTION_URL` is optional —
 * without it the server runs the pipeline in process, which is what a local
 * `npm run serve` wants.
 */
async function refreshCalendar() {
  if (REFRESH_FUNCTION_URL) {
    const res = await fetch(REFRESH_FUNCTION_URL, {
      method: "POST",
      headers: REFRESH_TOKEN ? { Authorization: `Bearer ${REFRESH_TOKEN}` } : {},
    });
    const body = await res.json().catch(() => ({}));
    invalidate();
    return {
      ok: res.ok && body.ok !== false,
      summary: body.summary || `Neon refresh responded ${res.status}`,
      error: body.error || (res.ok ? null : `HTTP ${res.status}`),
    };
  }

  if (!dbEnabled()) {
    // Unchanged local behaviour: rebuild the files in place.
    const result = await runBuildProcess();
    invalidate();
    return {
      ok: result.ok,
      summary: result.out.split("\n").filter(Boolean).slice(0, 4).join(" · "),
      error: result.ok ? null : result.err.slice(0, 400),
    };
  }

  const lines = [];
  const started = Date.now();
  try {
    const { payload, failed } = await buildCalendar({
      force: true,
      log: (line) => lines.push(line),
    });
    const result = await writeSnapshot(getPool(), payload, {
      source: "render",
      durationMs: Date.now() - started,
    });
    invalidate();
    return {
      ok: !failed.f1 && !failed.standings,
      summary:
        `rebuilt ${result.events} events into Neon in ${Date.now() - started} ms · ` +
        lines.slice(0, 2).join(" · "),
      error: null,
    };
  } catch (err) {
    await recordFailure(getPool(), "render", err);
    return { ok: false, summary: "", error: String(err.message || err).slice(0, 400) };
  }
}

/* ------------------------------------------------------------------ server */

function send(res, status, type, body, extra = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(payload);
}

function json(res, status, value) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function resolveTarget(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = path.resolve(ROOT, rel);
  // Keep requests inside the project and away from dotfiles.
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  if (rel.split(path.sep).some((seg) => seg.startsWith("."))) return null;
  return target;
}

let refreshing = false;

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (pathname === "/healthz") {
      if (!dbEnabled()) return json(res, 200, { ok: true, database: "files" });
      const meta = await readMeta(getPool());
      return json(res, meta ? 200 : 503, {
        ok: Boolean(meta),
        database: "neon",
        generatedAt: meta ? new Date(meta.generated_at).toISOString() : null,
        events: meta ? meta.event_count : 0,
      });
    }

    if (pathname === "/api/status") {
      if (!dbEnabled()) return json(res, 200, { database: "files" });
      const meta = await readMeta(getPool());
      return json(res, 200, {
        database: "neon",
        generatedAt: meta ? new Date(meta.generated_at).toISOString() : null,
        season: meta?.season ?? null,
        events: meta?.event_count ?? 0,
        clubs: Number(meta?.clubs ?? 0),
        leagues: Number(meta?.leagues ?? 0),
        refreshedBy: meta?.refreshed_by ?? null,
      });
    }

    if (pathname === "/api/calendar") {
      const snapshot = await currentSnapshot();
      if (snapshot) return json(res, 200, snapshot);
      return send(res, 200, TYPES[".json"], await fileFallback("data/calendar.json"));
    }

    if (pathname === "/api/refresh") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      // This re-fetches Wikipedia, so it is never open to anonymous callers on
      // a public host: a token unlocks it remotely, and a request from the LAN
      // (where the header button lives) is allowed without one.
      if (!refreshAuthorised(req)) return json(res, 403, { ok: false, error: "not authorised" });

      if (refreshing) return json(res, 409, { ok: false, busy: true });
      refreshing = true;
      res.setTimeout(0);
      const result = await refreshCalendar();
      refreshing = false;
      return json(res, result.ok ? 200 : 500, result);
    }

    if (pathname === "/data/calendar.js") {
      const snapshot = await currentSnapshot();
      if (snapshot) {
        const body =
          `// Served from Neon — generated ${snapshot.generatedAt}\n` +
          `window.CALENDAR_DATA = ${JSON.stringify(snapshot)};\n`;
        return send(res, 200, TYPES[".js"], body);
      }
      return send(res, 200, TYPES[".js"], await fileFallback("data/calendar.js"));
    }

    if (pathname.startsWith("/calendar/") && pathname.endsWith(".ics")) {
      const snapshot = await currentSnapshot();
      if (snapshot) {
        const wanted = path.basename(pathname);
        const file = calendarFiles(snapshot).find((f) => f.file === wanted);
        if (file) return send(res, 200, TYPES[".ics"], file.content);
        return send(res, 404, "text/plain; charset=utf-8", "Not found");
      }
      // fall through to the files on disk
    }

    const target = resolveTarget(pathname);
    if (!target) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    let info;
    try {
      info = await stat(target);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    if (info.isDirectory()) {
      res.writeHead(301, { Location: `${pathname.replace(/\/$/, "")}/index.html` }).end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(target)] || "application/octet-stream",
      "Content-Length": info.size,
      // Re-read after every refresh so a phone never shows a stale calendar.
      "Cache-Control": "no-store",
    });
    createReadStream(target).pipe(res);
  } catch (err) {
    console.error("request failed:", pathname, err.message);
    if (!res.headersSent) json(res, 500, { ok: false, error: "internal error" });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const addrs = lanAddresses();
  const source = dbEnabled() ? "Neon Postgres" : "files on disk";
  console.log(`Sports Calendar serving ${ROOT} from ${source}`);
  console.log(`  this device   http://localhost:${PORT}/`);
  for (const a of addrs) console.log(`  on your Wi-Fi http://${a}:${PORT}/`);
  if (!dbEnabled()) console.log("\nOpen one of the Wi-Fi URLs on your phone (same network).");
  console.log("Ctrl-C to stop.");
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
