import { defineConfig } from "@playwright/test";

/**
 * The browser walks (`pnpm test:browser`): Playwright's own project, apart
 * from Vitest, against the built server on a database made for the run.
 * `tests/browser/run.ts` makes the database and the port and starts this
 * configuration; it is not run on its own.
 */
const port = Number(process.env.BROWSER_TEST_PORT);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("run the browser walks with `pnpm test:browser`, which sets BROWSER_TEST_PORT");
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: "../../test-results/browser",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    headless: true,
    trace: "off",
  },
  webServer: {
    command: `pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
