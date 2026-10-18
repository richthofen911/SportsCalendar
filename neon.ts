// Neon branch policy for the Sports Calendar.
//
//   neon config plan     diff what this would change (read-only)
//   neon deploy          apply it: deploy the function, create the trigger
//
// The function is the only writer of the calendar in production: it re-runs the
// same pipeline `npm run refresh` uses and replaces the rows in Postgres. The
// cron trigger is what makes that recur without this Mac being awake.
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  functions: {
    refresh: {
      name: "Sports Calendar refresh",
      source: "src/refresh/index.ts",
      env: {
        // A Function has no writable project directory, so the Wikipedia page
        // cache is switched off and every page is fetched fresh. The cache is
        // an optimisation, never a source of truth.
        SPORTS_CALENDAR_CACHE: "off",
        // How much history the calendar keeps. Every full rebuild replaces the
        // snapshot, so this is also the database's retention: anything that
        // finished more than six months ago is not written back. Raise it to
        // keep a whole season in view (a rolling window starts dropping the
        // season's opening matches from mid-season).
        RETENTION_MONTHS: "6",
        // Only sent when it is present, so `neon deploy` works before Render
        // has generated the value. Once you copy it into `.env.local`, deploy
        // with `--env .env.local` and the function accepts manual refreshes
        // from the web service. Without it, only the cron trigger can refresh.
        ...(process.env.REFRESH_TOKEN ? { REFRESH_TOKEN: process.env.REFRESH_TOKEN } : {}),
      },
    },
  },
  triggers: {
    "calendar-live": {
      type: "schedule",
      function: "refresh",
      // Every quarter hour. The function does almost nothing on a tick with no
      // match in play — two small queries — and only then does it consider a
      // full rebuild. That is what keeps a matchday fresh without crawling
      // Wikipedia 96 times a day.
      cron: "*/15 * * * *",
      functionPath: "/refresh",
    },
  },
});
