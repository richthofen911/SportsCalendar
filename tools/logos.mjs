// Club crests and league logos, fetched once and kept in `assets/logos/`.
//
// The page has no CDN behind it and is expected to work from `file://` and from
// GitHub Pages, so the images are downloaded at build time and committed rather
// than hotlinked at runtime. Wikipedia's lead image for each club's own article
// is the crest; the season pages this tool parses carry a stadium photo or
// nothing, which is why `clubs.mjs` names a separate `logoPage`.
//
// These crests are non-free, fair-use images on Wikipedia. Vendoring them is a
// deliberate choice for this repository and not a general-purpose licence.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { CLUBS, LEAGUES, clubLogo, leagueLogo } from "./clubs.mjs";
import { fetchBytes, fetchJson } from "./wiki.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "assets", "logos");
const MANIFEST = path.join(DIR, "manifest.json");

/** Every logo the page can ask for, keyed by the file it lives in. */
export function logoManifest() {
  return [
    ...CLUBS.map((c) => ({
      key: c.id,
      file: `${c.id}.png`,
      href: clubLogo(c.id),
      page: c.logoPage,
    })),
    ...LEAGUES.map((l) => ({
      key: `league-${l.id}`,
      file: `league-${l.id}.png`,
      href: leagueLogo(l.id),
      page: l.logoPage,
    })),
  ];
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST, "utf8"));
  } catch {
    return { images: {} };
  }
}

/**
 * One batched call for every lead image, rather than one per club.
 *
 * `pilicense=any` is what makes this work at all: crests and league logos are
 * non-free, and the API omits them by default. Wikipedia normalises titles
 * ("Arsenal F.C." may come back as "Arsenal F.C." with the punctuation
 * changed) and follows redirects, so the response is mapped back through both
 * alias tables before being trusted.
 */
export async function fetchLeadImages(pages) {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&format=json&formatversion=2" +
    "&piprop=thumbnail%7Cname&pithumbsize=250&pilicense=any&redirects=1&titles=" +
    encodeURIComponent(pages.join("|"));

  const body = await fetchJson(url);
  if (body.error) throw new Error(`${body.error.code}: ${body.error.info}`);

  const query = body.query || {};
  const resolve = new Map();
  for (const n of query.normalized || []) resolve.set(n.from, n.to);
  for (const r of query.redirects || []) resolve.set(r.from, r.to);

  const byTitle = new Map();
  for (const p of query.pages || []) {
    if (p.missing) continue;
    if (p.thumbnail && p.thumbnail.source) byTitle.set(p.title, p.thumbnail.source);
  }

  const out = new Map();
  for (const page of pages) {
    let title = page;
    for (let hops = 0; hops < 5 && resolve.has(title); hops++) title = resolve.get(title);
    const source = byTitle.get(title);
    if (source) out.set(page, source);
  }
  return out;
}

/**
 * Make `assets/logos/` match what `clubs.mjs` asks for.
 *
 * Nothing here is fatal: a Wikipedia hiccup keeps the logo already on disk and
 * reports it, because a stale crest is much better than a broken build.
 */
export async function refreshLogos({ force = false, log = console.log } = {}) {
  const entries = logoManifest();
  await mkdir(DIR, { recursive: true });
  const previous = await readManifest();
  const images = { ...(previous.images || {}) };

  let leads;
  try {
    leads = await fetchLeadImages(entries.map((e) => e.page));
  } catch (err) {
    log(`logos: could not read Wikipedia lead images (${err.message}); keeping the files on disk`);
    return { downloaded: 0, skipped: 0, failed: entries.map((e) => e.key), offline: true };
  }

  let downloaded = 0;
  let skipped = 0;
  const failed = [];
  const kept = [];

  for (const entry of entries) {
    const dest = path.join(DIR, entry.file);
    const source = leads.get(entry.page);
    const known = images[entry.key];

    if (!source) {
      // No lead image on that article: leave whatever is already committed.
      if (existsSync(dest)) kept.push(entry.key);
      else failed.push(entry.key);
      continue;
    }

    if (!force && known && known.source === source && existsSync(dest)) {
      skipped++;
      continue;
    }

    try {
      const { bytes, contentType } = await fetchBytes(source);
      if (!/^image\//.test(contentType)) {
        throw new Error(`unexpected content type "${contentType}"`);
      }
      // Every target here is an SVG logo, whose thumbnail is a PNG. If that ever
      // stops being true the manifest records the real type so it can be seen.
      await writeFile(dest, bytes);
      images[entry.key] = {
        page: entry.page,
        source,
        contentType,
        bytes: bytes.length,
        fetchedAt: new Date().toISOString(),
      };
      downloaded++;
    } catch (err) {
      if (existsSync(dest)) kept.push(entry.key);
      else failed.push(entry.key);
      log(`logos: ${entry.key} failed (${err.message})`);
    }
  }

  await writeFile(
    MANIFEST,
    JSON.stringify({ updatedAt: new Date().toISOString(), images }, null, 2) + "\n"
  );

  return { downloaded, skipped, failed, kept };
}
