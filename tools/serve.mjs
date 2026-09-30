// Static server for the LAN, plus an endpoint that re-runs the build so the
// phone can pull fresh scores without touching the Mac.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const PORT = Number(arg("port", process.env.PORT || 4173));
const HOST = arg("host", "0.0.0.0");

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

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
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

function runBuild() {
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

let refreshing = false;

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (pathname === "/api/refresh") {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (refreshing) {
      res.writeHead(409, { "Content-Type": "application/json" }).end(
        JSON.stringify({ ok: false, busy: true })
      );
      return;
    }
    refreshing = true;
    res.setTimeout(0);
    const result = await runBuild();
    refreshing = false;
    const summary = result.out.split("\n").filter(Boolean).slice(0, 4).join(" · ");
    res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: result.ok, summary, error: result.ok ? null : result.err.slice(0, 400) }));
    return;
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
});

server.listen(PORT, HOST, () => {
  const addrs = lanAddresses();
  console.log(`Sports Calendar serving ${ROOT}`);
  console.log(`  this device   http://localhost:${PORT}/`);
  for (const a of addrs) console.log(`  on your Wi-Fi http://${a}:${PORT}/`);
  console.log("\nOpen one of the Wi-Fi URLs on your phone (same network).");
  console.log("Ctrl-C to stop.");
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
