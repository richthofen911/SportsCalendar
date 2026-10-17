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
import { ESPN_SLUGS } from "./espn.mjs";
import { norm, sameTeam } from "./teams.mjs";
import { fetchBytes, fetchJson } from "./wiki.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "assets", "logos");
const MANIFEST = path.join(DIR, "manifest.json");
const TEAM_DIR = path.join(DIR, "teams");
const TEAM_MANIFEST = path.join(TEAM_DIR, "manifest.json");

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

  // Only rewrite the manifest when something actually changed, so a routine
  // `npm run refresh` does not dirty the working tree with a new timestamp.
  const previousImages = JSON.stringify(previous.images || {});
  if (downloaded > 0 || JSON.stringify(images) !== previousImages) {
    await writeFile(
      MANIFEST,
      JSON.stringify({ updatedAt: new Date().toISOString(), images }, null, 2) + "\n"
    );
  }

  return { downloaded, skipped, failed, kept };
}

/* ------------------------------------------------- opponent crests (ESPN) */

const ESPN_TEAM_LEAGUES = [
  "eng.1", "esp.1", "ger.1", "fra.1",
  "uefa.champions",
  "eng.league_cup", "ger.dfb_pokal", "fra.coupe_de_france", "eng.fa",
  "ger.2", "fra.2", "esp.2",
];

/**
 * A stable filename for any club name.
 *
 * The page derives the same path from the team name it is about to draw —
 * `/assets/logos/teams/<slug>.png` — so no lookup table has to travel with the
 * payload, and the Neon Function needs no filesystem to name a crest it will
 * never see. `norm` is shared with tools/teams.mjs, so both sides agree.
 */
export function teamSlug(name) {
  return norm(name).replace(/\s+/g, "-");
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ESPN's CDN is a different host with its own (generous) limits, so it does not
// share Wikipedia's two-second gate — 90 crests would otherwise take minutes.
async function fetchImage(url) {
  const res = await fetch(url, { headers: { "User-Agent": "SportsCalendar/1.0 (crest fetch)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "",
  };
}

async function espnTeams(log) {
  const out = [];
  for (const league of ESPN_TEAM_LEAGUES) {
    try {
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/teams`,
        { headers: { "User-Agent": "SportsCalendar/1.0 (crest list)" } }
      );
      if (!res.ok) continue;
      const body = await res.json();
      const teams = (((body.sports || [])[0] || {}).leagues || [])[0]?.teams || [];
      for (const t of teams) {
        const name = t.team?.displayName || t.team?.name;
        const logo = (t.team?.logos || []).find((l) => l.href)?.href;
        if (name && logo) out.push({ name, id: t.team.id, logo, league });
      }
    } catch (err) {
      log(`teams: ${league} unavailable (${err.message})`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

/**
 * Pick the ESPN team for a name, or nothing at all.
 *
 * The clubs whose competitions we know are tried first: "Inter Milan" only
 * resolves cleanly inside the Champions League / Serie A pool, where it is not
 * competing with Inter Miami. Within a pool, exact normalised names win; if the
 * loose comparison still leaves more than one distinct crest the name is
 * ambiguous, and the safe answer is to draw no crest rather than the wrong one.
 */
function pickTeam(name, teams, preferredLeagues) {
  const pools = [teams.filter((t) => preferredLeagues.has(t.league)), teams];
  for (const pool of pools) {
    const exact = pool.filter((t) => norm(t.name) === norm(name));
    const loose = exact.length ? exact : pool.filter((t) => sameTeam(t.name, name));
    const distinct = new Map(loose.map((t) => [t.logo, t]));
    if (distinct.size === 1) return [...distinct.values()][0];
  }
  return null;
}

/**
 * Make `assets/logos/teams/` cover every club named in the fixtures.
 *
 * Only names with no file on disk are looked up, so a routine build costs
 * nothing; a new opponent (a cup draw, say) costs one ESPN listing and one
 * download. The six tracked clubs are skipped — their crests already exist and
 * the page renders those from `clubs.mjs`.
 */
export async function refreshTeamLogos(events, { force = false, log = console.log } = {}) {
  await mkdir(TEAM_DIR, { recursive: true });
  const previous = await readJson(TEAM_MANIFEST, { teams: {} });
  const teams = { ...(previous.teams || {}) };

  const tracked = (name) => CLUBS.some((c) => sameTeam(c.name, name));

  const wanted = new Map();
  const leaguesFor = new Map();
  for (const e of events) {
    if (e.category === "formula-1") continue;
    const leagueSlug = ESPN_SLUGS[e.competition];
    for (const name of [e.homeTeam, e.awayTeam]) {
      if (!name || /^tbd$/i.test(name) || tracked(name)) continue;
      const slug = teamSlug(name);
      if (!slug) continue;
      if (!wanted.has(name)) wanted.set(name, slug);
      if (leagueSlug) {
        if (!leaguesFor.has(name)) leaguesFor.set(name, new Set());
        leaguesFor.get(name).add(leagueSlug);
      }
    }
  }

  const missing = [...wanted].filter(
    ([, slug]) => force || !existsSync(path.join(TEAM_DIR, `${slug}.png`))
  );
  if (!missing.length) return { added: 0, missing: 0, total: wanted.size, unresolved: [] };

  const espn = await espnTeams(log);
  if (!espn.length) {
    log("teams: no ESPN team lists available; opponent crests left as they are");
    return { added: 0, missing: missing.length, total: wanted.size, unresolved: [], offline: true };
  }

  let added = 0;
  const written = new Set();
  const unresolved = [];

  for (const [name, slug] of missing) {
    if (written.has(slug)) continue;
    const hit = pickTeam(name, espn, leaguesFor.get(name) || new Set());
    if (!hit) {
      unresolved.push(name);
      continue;
    }
    try {
      const { bytes, contentType } = await fetchImage(hit.logo);
      if (!/^image\//.test(contentType)) throw new Error(`unexpected content type "${contentType}"`);
      await writeFile(path.join(TEAM_DIR, `${slug}.png`), bytes);
      teams[name] = {
        slug,
        espnId: hit.id,
        source: hit.logo,
        bytes: bytes.length,
        fetchedAt: new Date().toISOString(),
      };
      written.add(slug);
      added++;
      await new Promise((r) => setTimeout(r, 80));
    } catch (err) {
      unresolved.push(name);
      log(`teams: ${name} failed (${err.message})`);
    }
  }

  if (added > 0 || JSON.stringify(teams) !== JSON.stringify(previous.teams || {})) {
    await writeFile(
      TEAM_MANIFEST,
      JSON.stringify({ updatedAt: new Date().toISOString(), teams }, null, 2) + "\n"
    );
  }

  return { added, missing: missing.length, total: wanted.size, unresolved };
}
