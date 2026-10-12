import { defineConfig } from "@playwright/test";

/*
 * The browser suite (`pnpm test:browser`): the practice's screens and the
 * owner's phone flow, against one production server (`next build && next
 * start`) on a database made for the run. `tests/browser/run.ts` makes the
 * database, the port and the session secret and starts this configuration;
 * it is not run on its own.
 */

const port = Number(process.env.PAWHOLD_BROWSER_PORT);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(
    "run the browser suite with `pnpm test:browser`, which sets PAWHOLD_BROWSER_PORT",
  );
}
const baseURL = `http://127.0.0.1:${port}`;

/*
 * Without sandbox credentials, the server alone is pointed at the run's
 * PayPal double (tests/browser/run.ts); the walks' own processes keep no
 * PayPal values, so the owner's sandbox walks still skip.
 */
const doubleUrl = process.env.PAWHOLD_BROWSER_PAYPAL_DOUBLE_URL;
const serverPayPal: Record<string, string> = doubleUrl
  ? {
      PAYPAL_CLIENT_ID: "pawhold-browser-double",
      PAYPAL_CLIENT_SECRET: "pawhold-browser-double",
      PAYPAL_DOUBLE_URL: doubleUrl,
    }
  : {};

export default defineConfig({
  testDir: "tests/browser",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results/browser",
  forbidOnly: true,
  retries: 0,
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    locale: "en-GB",
    timezoneId: "Europe/London",
    trace: "off",
  },
  projects: [
    {
      // The practice's screens, each test at 1440 and 390 px through its own
      // browser (tests/browser/fixtures.ts).
      name: "practice",
      testIgnore: "owner/**",
      fullyParallel: true,
    },
    {
      // The owner's phone: 390 px wide with touch (plan 5, U6's acceptance).
      // Each file shares its database handle and cases across its tests.
      name: "owner-390",
      testDir: "tests/browser/owner",
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        hasTouch: true,
      },
    },
    {
      // The same link opened on a laptop. The sandbox walks run at 390 only,
      // so a run with PayPal's values leaves one set of holds to void.
      name: "owner-1440",
      testDir: "tests/browser/owner",
      testIgnore: "sandbox.spec.ts",
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: serverPayPal,
    timeout: 300_000,
    // The server logs each request's path, which holds an owner's link token.
    stdout: "ignore",
    stderr: "pipe",
  },
});
