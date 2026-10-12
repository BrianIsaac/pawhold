import { defineConfig } from "@playwright/test";

import { liveBaseUrl } from "./tests/live/support/target";

/*
 * The live smoke (`pnpm test:live`, U10): against the deployment
 * (`https://pawhold.onrender.com`), or `PAWHOLD_LIVE_URL`. Two projects:
 * `uptime`, the thirty-minute check, which asks the health check and the
 * landing page and opens no browser and no session; and `walk`, the README's
 * testing instructions walked in a browser with PayPal's sandbox and the
 * live model, after the uptime check passes. Nothing here starts a server:
 * the smoke walks what judges will.
 */

export default defineConfig({
  testDir: "tests/live",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results/live",
  forbidOnly: true,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: liveBaseUrl(),
    browserName: "chromium",
    headless: true,
    locale: "en-GB",
    timezoneId: "Europe/London",
    // No trace, shot or video: the PayPal window shows the buyer's login.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      // One retry: a single dropped request is not an outage, two in a row are.
      name: "uptime",
      testMatch: "uptime.spec.ts",
      retries: 1,
      timeout: 60_000,
    },
    {
      // No retry: each attempt makes a judge session and a sandbox hold.
      name: "walk",
      testMatch: "walk.spec.ts",
      dependencies: ["uptime"],
      retries: 0,
      timeout: 10 * 60_000,
      expect: { timeout: 20_000 },
    },
  ],
});
