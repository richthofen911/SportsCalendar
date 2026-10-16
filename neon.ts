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
        // Only sent when it is present, so `neon deploy` works before Render
        // has generated the value. Once you copy it into `.env.local`, deploy
        // with `--env .env.local` and the function accepts manual refreshes
        // from the web service. Without it, only the cron trigger can refresh.
        ...(process.env.REFRESH_TOKEN ? { REFRESH_TOKEN: process.env.REFRESH_TOKEN } : {}),
      },
    },
  },
  triggers: {
    "calendar-twice-daily": {
      type: "schedule",
      function: "refresh",
      // 07:15 and 19:15 UTC — the same twice-daily rhythm as the LaunchAgent,
      // expressed in the only clock a cron trigger has.
      cron: "15 7,19 * * *",
      functionPath: "/refresh",
    },
  },
});
