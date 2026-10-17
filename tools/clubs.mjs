export const SEASON = "2026–27";

// `logoPage` is the article whose lead image is the club's crest or the league's
// logo. The season pages this tool parses carry a stadium photo or nothing at
// all, so the badge has to come from the club's own article. See tools/logos.mjs.
export const CLUBS = [
  {
    id: "real-madrid",
    name: "Real Madrid",
    short: "RMA",
    color: "#00529F",
    page: `${SEASON} Real Madrid CF season`,
    logoPage: "Real Madrid CF",
  },
  {
    id: "barcelona",
    name: "FC Barcelona",
    short: "BAR",
    color: "#A50044",
    page: `${SEASON} FC Barcelona season`,
    logoPage: "FC Barcelona",
  },
  {
    id: "arsenal",
    name: "Arsenal",
    short: "ARS",
    color: "#EF0107",
    page: `${SEASON} Arsenal F.C. season`,
    logoPage: "Arsenal F.C.",
  },
  {
    id: "man-city",
    name: "Manchester City",
    short: "MCI",
    color: "#1C6EA6",
    page: `${SEASON} Manchester City F.C. season`,
    logoPage: "Manchester City F.C.",
  },
  {
    id: "bayern",
    name: "Bayern Munich",
    short: "BAY",
    color: "#DC0531",
    page: `${SEASON} FC Bayern Munich season`,
    logoPage: "FC Bayern Munich",
  },
  {
    id: "psg",
    name: "Paris Saint-Germain",
    short: "PSG",
    color: "#004170",
    page: `${SEASON} Paris Saint-Germain FC season`,
    logoPage: "Paris Saint-Germain F.C.",
  },
];

// Each category names the teams it can be filtered by; the UI builds one
// dropdown per active category that has any. Formula 1 is a single series, so
// it has none.
export const CATEGORIES = [
  {
    id: "football",
    name: "Football",
    color: "#2E7D32",
    teamsLabel: "Clubs",
    teams: CLUBS.map((c) => c.id),
  },
  {
    id: "formula-1",
    name: "Formula 1",
    color: "#B3212B",
    teamsLabel: "Teams",
    teams: [],
    page: "2026 Formula One World Championship",
    year: 2026,
  },
];

export const LEAGUES = [
  {
    id: "premier-league",
    name: "Premier League",
    page: `${SEASON} Premier League`,
    logoPage: "Premier League",
  },
  {
    id: "la-liga",
    name: "La Liga",
    page: `${SEASON} La Liga`,
    logoPage: "La Liga",
  },
  {
    id: "bundesliga",
    name: "Bundesliga",
    page: `${SEASON} Bundesliga`,
    logoPage: "Bundesliga",
  },
  {
    id: "ligue-1",
    name: "Ligue 1",
    page: `${SEASON} Ligue 1`,
    logoPage: "Ligue 1",
  },
];

/* ------------------------------------------------------------------ logo paths */

// Both are derived from a stable id, so the payload can name a logo without
// having fetched anything — which is what lets the Neon refresh Function stay
// filesystem-free while still writing logo paths to Postgres.
//
// No leading slash: the page has to work from `file://` as well as from a
// server, where `/assets/...` would resolve to the filesystem root.
export const clubLogo = (id) => `assets/logos/${id}.png`;
export const leagueLogo = (leagueId) => `assets/logos/league-${leagueId}.png`;
