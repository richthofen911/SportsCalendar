// CLI: build the calendar and write it to disk.
//
// The fetch/parse/generate work lives in `pipeline.mjs`; this file is the part
// that knows about `data/`, `calendar/` and `.cache/`. The Neon refresh
// Function runs the same pipeline and writes to Postgres instead.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { buildCalendar, checkIcsFiles } from "./pipeline.mjs";
import { writeSiteFiles } from "./site-files.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const force = process.argv.includes("--force");

const { payload, files, failed, report } = await buildCalendar({ force });
const { report: detail, timeConfidence, comps, f1Report, standingsReport, counts } = report;

console.log(
  `combined calendar: ${counts.combined} entries (${counts.merged} shared fixtures merged)`
);

await writeSiteFiles(ROOT, payload, files);

console.log(
  `\nfootball rows: ${counts.football}   f1 rounds: ${counts.f1}   league tables: ${counts.standings}   ics files: ${counts.icsFiles}`
);
console.log("time confidence:", JSON.stringify(timeConfidence));
console.log("skipped blocks:", detail.skipped.length);
for (const s of detail.skipped.slice(0, 10)) console.log("  ", JSON.stringify(s));
console.log("duplicates:", detail.duplicates.length);
console.log("undated:", detail.noDate.length);
for (const s of detail.noDate.slice(0, 10)) console.log("  ", JSON.stringify(s));

console.log("\ncompetitions:");
for (const [k, v] of Object.entries(comps).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}

const icsProblems = checkIcsFiles(files);
if (icsProblems.length) {
  console.error("\nICS self-check FAILED:");
  for (const p of icsProblems.slice(0, 20)) console.error("  ", p);
  process.exitCode = 1;
} else {
  console.log("ICS self-check: ok (folding, timestamps, UIDs)");
}

await mkdir(path.join(ROOT, ".cache"), { recursive: true });
await writeFile(path.join(ROOT, ".cache", "report.json"), JSON.stringify(report, null, 2));
if (f1Report.unmatchedF1.length) console.log("F1 rounds without a start time:", f1Report.unmatchedF1.length);
if (f1Report.dateSpread.length) console.log("F1 date disagreements (wiki vs ESPN):", JSON.stringify(f1Report.dateSpread));
if (standingsReport.problems.length) console.log("unparseable league rows:", standingsReport.problems.length);
if (standingsReport.orphanCodes.length) console.log("team codes without a name:", JSON.stringify(standingsReport.orphanCodes));
if (failed.f1 || failed.standings) process.exitCode = 1;
