// Installs (or removes) a macOS user agent that publishes the calendar twice a
// day. No admin rights needed: this is a per-user LaunchAgent.
//   node tools/install-scheduler.mjs [--times 07:15,19:15] [--uninstall]
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LABEL = "com.sportscalendar.refresh";
const AGENT_DIR = path.join(homedir(), "Library", "LaunchAgents");
const PLIST = path.join(AGENT_DIR, `${LABEL}.plist`);
const LOG_DIR = path.join(homedir(), "Library", "Logs");
const LOG = path.join(LOG_DIR, "SportsCalendar-refresh.log");
const NPM_DIR = path.dirname(process.execPath);

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

function sh(cmd) {
  const r = spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

if (argv.includes("--uninstall")) {
  sh(`launchctl bootout gui/${process.getuid()}/${LABEL} 2>/dev/null || true`);
  if (existsSync(PLIST)) {
    const moved = `${PLIST}.removed`;
    writeFileSync(moved, readFileSync(PLIST));
    sh(`rm -f "${PLIST}"`);
    console.log(`Removed ${PLIST} (previous copy kept at ${moved})`);
  } else {
    console.log("No scheduler installed.");
  }
  process.exit(0);
}

const times = String(arg("times", "07:15,19:15"))
  .split(",")
  .map((t) => {
    const [hour, minute] = t.trim().split(":").map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) throw new Error(`bad time: ${t}`);
    return { Hour: hour, Minute: minute };
  });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NPM_DIR}/node</string>
    <string>${path.join(ROOT, "tools", "publish.mjs")}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${NPM_DIR}:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${times.map((t) => `    <dict><key>Hour</key><integer>${t.Hour}</integer><key>Minute</key><integer>${t.Minute}</integer></dict>`).join("\n")}
  </array>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;

mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
writeFileSync(PLIST, plist);
if (existsSync(`${PLIST}.removed`)) sh(`rm -f "${PLIST}.removed"`);

sh(`launchctl bootout gui/${process.getuid()}/${LABEL} 2>/dev/null || true`);
const boot = sh(`launchctl bootstrap gui/${process.getuid()} "${PLIST}"`);
if (boot.code !== 0) {
  console.error("launchctl bootstrap failed:\n" + boot.out);
  process.exit(1);
}
const listed = sh(`launchctl print gui/${process.getuid()}/${LABEL} | head -5`);

console.log(`Installed ${PLIST}`);
console.log(`Runs at: ${times.map((t) => `${String(t.Hour).padStart(2, "0")}:${String(t.Minute).padStart(2, "0")}`).join(", ")} local time`);
console.log(`Log:     ${LOG}`);
console.log(`\n${listed.out.trim()}`);
console.log("\nTest it now:  launchctl kickstart -k gui/" + process.getuid() + "/" + LABEL);
