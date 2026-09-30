// Refresh the data and publish it to GitHub, which redeploys the Pages site.
// Run from cron/launchd: `npm run publish`. Add --dry-run to skip the push.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");

function git(args, { allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return (r.stdout || "").trim();
}

function step(label, args) {
  console.log(`\n$ ${label}`);
  const r = spawnSync("/bin/sh", ["-c", args], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${label} exited ${r.status}`);
}

const generated = ["data/calendar.js", "data/calendar.json"];
const icsDir = path.join(ROOT, "calendar");
if (existsSync(icsDir)) {
  for (const f of spawnSync("/bin/sh", ["-c", "ls calendar/*.ics"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n")) {
    if (f.trim()) generated.push(f.trim());
  }
}

step("refresh", "node tools/build.mjs --force");

git(["add", "--", ...generated]);
const staged = git(["diff", "--cached", "--name-only"]);
if (!staged) {
  console.log("\nNothing changed since the last publish — no commit, no push.");
  process.exit(0);
}

console.log(`\nChanges:\n${staged.split("\n").map((l) => `  ${l}`).join("\n")}`);

const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
git(["commit", "-m", `Update fixtures, results and standings (${stamp})`]);

if (dryRun) {
  console.log("\n--dry-run: commit made locally, nothing pushed.");
  process.exit(0);
}

git(["push", "origin", "HEAD:main"]);
console.log("\nPushed. GitHub Actions will redeploy the Pages site in about a minute.");
