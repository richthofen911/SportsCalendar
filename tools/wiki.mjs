import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE_DIR = path.join(ROOT, ".cache");

// A Neon Function has no writable project directory, so the cache is switched
// off there with SPORTS_CALENDAR_CACHE=off and every page is fetched fresh.
// Nothing else changes: the cache is an optimisation, never a source of truth.
function cacheEnabled() {
  const setting = process.env.SPORTS_CALENDAR_CACHE;
  return setting !== "off" && setting !== "0" && setting !== "false";
}

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

/**
 * One request to Wikipedia, spaced out and backing off on 429.
 *
 * Exported so `tools/logos.mjs` shares this throttle rather than inventing its
 * own: the rate limit is per client, and a build now makes a couple of dozen
 * requests between the pages and the crests.
 */
export async function politeFetch(url, { headers = {}, ...rest } = {}) {
  let delay = 2000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await throttle();
    const res = await fetch(url, { headers: { ...HEADERS, ...headers }, ...rest });
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
    return res;
  }
  throw new Error(`gave up after repeated 429s: ${url}`);
}

export async function fetchJson(url) {
  return (await politeFetch(url)).json();
}

/** Fetch an image as bytes, keeping the content type for validation. */
export async function fetchBytes(url) {
  const res = await politeFetch(url, { headers: { Accept: "image/*,*/*;q=0.8" } });
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "",
  };
}

export async function fetchWikitext({ page, force = false }) {
  const useCache = cacheEnabled();
  if (useCache) await mkdir(CACHE_DIR, { recursive: true });
  const slug = page.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const cacheFile = path.join(CACHE_DIR, `${slug}.json`);

  if (useCache && !force && existsSync(cacheFile)) {
    const cached = JSON.parse(await readFile(cacheFile, "utf8"));
    return { ...cached, fromCache: true };
  }

  const api =
    "https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2" +
    "&prop=wikitext&redirects=1&disableeditsection=1&page=" +
    encodeURIComponent(page);

  const body = await fetchJson(api);
  if (body.error) throw new Error(`${body.error.code}: ${body.error.info}`);

  const entry = {
    requested: page,
    title: body.parse.title,
    pageId: body.parse.pageid,
    wikitext: body.parse.wikitext,
    fetchedAt: new Date().toISOString(),
    fromCache: false,
  };
  if (useCache) await writeFile(cacheFile, JSON.stringify(entry));
  return entry;
}
