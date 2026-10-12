import { randomBytes } from "node:crypto";

import { defineConfig } from "@playwright/test";

/*
 * The browser suite (`pnpm test:browser`): the application served by `next
 * dev` against a test database of its own, made and migrated for the run and
 * dropped after it (tests/browser/serve.ts), driven by a headless Chromium
 * closed after every test. The run's database name and session secret are
 * fixed here, once, in the runner's environment, which the server and the
 * workers inherit.
 */

const port = Number(process.env.PAWHOLD_BROWSER_PORT ?? 3061);
const baseURL = `http://localhost:${port}`;

process.env.PAWHOLD_BROWSER_DATABASE ??= `pawhold_browser_${randomBytes(6).toString("hex")}`;
process.env.PAWHOLD_BROWSER_SECRET ??= randomBytes(32).toString("base64url");
process.env.PAWHOLD_BROWSER_BASE_URL = baseURL;

export default defineConfig({
  testDir: "tests/browser",
  outputDir: "test-results",
  forbidOnly: Boolean(process.env.CI),
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
    trace: "retain-on-failure",
  },
  projects: [
    {
      // The owner's phone: 390 px wide (plan 5, U6's acceptance).
      name: "owner",
      testDir: "tests/browser/owner",
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "tsx tests/browser/serve.ts",
    url: `${baseURL}/api/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    // `next dev` logs each request's path, which holds an owner's link token.
    stdout: "ignore",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
    env: {
      PAWHOLD_BROWSER_PORT: String(port),
    },
  },
});
