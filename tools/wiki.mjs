import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE_DIR = path.join(ROOT, ".cache");

const HEADERS = {
  // Wikipedia's robot policy asks for a contactable UA on API calls.
  "User-Agent":
    "SportsCalendar/1.0 (personal fixture tracker; single-user local refresh)",
  Accept: "application/json",
};

const MIN_INTERVAL_MS = 2000;
let lastRequestAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function requestJson(url) {
  let delay = 2000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await throttle();
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : delay;
      console.warn(
        `  429 from Wikipedia, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt})`
      );
      await sleep(waitMs);
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.json();
  }
  throw new Error(`gave up after repeated 429s: ${url}`);
}

export async function fetchWikitext({ page, force = false }) {
  await mkdir(CACHE_DIR, { recursive: true });
  const slug = page.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const cacheFile = path.join(CACHE_DIR, `${slug}.json`);

  if (!force && existsSync(cacheFile)) {
    const cached = JSON.parse(await readFile(cacheFile, "utf8"));
    return { ...cached, fromCache: true };
  }

  const api =
    "https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2" +
    "&prop=wikitext&redirects=1&disableeditsection=1&page=" +
    encodeURIComponent(page);

  const body = await requestJson(api);
  if (body.error) throw new Error(`${body.error.code}: ${body.error.info}`);

  const entry = {
    requested: page,
    title: body.parse.title,
    pageId: body.parse.pageid,
    wikitext: body.parse.wikitext,
    fetchedAt: new Date().toISOString(),
    fromCache: false,
  };
  await writeFile(cacheFile, JSON.stringify(entry));
  return entry;
}
