import { join } from "node:path";

import type { Browser, BrowserContextOptions } from "@playwright/test";

import { expect, test, WIDTHS, type Width } from "./fixtures";

/*
 * Judge mode from the landing page (U9): the two doors, each a plain link,
 * and two judges' sessions kept apart. Each walk launches its own headless
 * browser and closes it when done.
 */

/**
 * Runs a walk in a headless browser of its own, closed whatever the outcome.
 *
 * @param launch - Launches the browser.
 * @param walk - The walk.
 * @returns Resolves when the walk is done.
 */
async function inOwnBrowser(
  launch: () => Promise<Browser>,
  walk: (browser: Browser) => Promise<void>,
): Promise<void> {
  const browser = await launch();
  try {
    await walk(browser);
  } finally {
    await browser.close();
  }
}

/**
 * A fresh visitor's context: the practice's width, UK English and time.
 *
 * @param baseURL - The server.
 * @param more - Anything else, such as JavaScript off.
 * @returns The options.
 */
function visitor(baseURL: string | undefined, more: BrowserContextOptions = {}) {
  return {
    ...(baseURL ? { baseURL } : {}),
    viewport: WIDTHS.desktop,
    locale: "en-GB",
    timezoneId: "Europe/London",
    ...more,
  };
}

test.describe("judge mode's doors", () => {
  test("'Try it as the practice' works without JavaScript and lands on the judge's own practice", async ({
    playwright,
    baseURL,
  }) => {
    await inOwnBrowser(
      () => playwright.chromium.launch({ headless: true }),
      async (browser) => {
        const context = await browser.newContext(visitor(baseURL, { javaScriptEnabled: false }));
        const page = await context.newPage();
        await page.goto("/");

        await page.getByRole("link", { name: "Try it as the practice" }).click();

        await expect(page).toHaveURL(/\/today$/);
        await expect(page.getByRole("heading", { level: 1, name: "Today's cases" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Bramble" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Otis" })).toBeVisible();
      },
    );
  });

  test("'Try it as the owner' works without JavaScript and lands on the estimate waiting for its owner", async ({
    playwright,
    baseURL,
  }) => {
    await inOwnBrowser(
      () => playwright.chromium.launch({ headless: true }),
      async (browser) => {
        const context = await browser.newContext(visitor(baseURL, { javaScriptEnabled: false }));
        const page = await context.newPage();
        await page.goto("/");

        await page.getByRole("link", { name: "Try it as the owner" }).click();

        await expect(page).toHaveURL(/\/e\/[A-Za-z0-9_-]{92}$/);
        await expect(
          page.getByRole("heading", {
            level: 1,
            name: "Otis's estimate from Hollins Lane Veterinary Surgery",
          }),
        ).toBeVisible();
        const sandbox = page.getByRole("complementary", { name: "Testing in PayPal's sandbox" });
        const shown = (await sandbox.textContent()) ?? "";
        // Compared without printing: in a sandbox run these are the published buyer's values.
        expect(shown.includes(process.env.PAYPAL_SANDBOX_BUYER_EMAIL!), "the buyer's email").toBe(
          true,
        );
        expect(
          shown.includes(process.env.PAYPAL_SANDBOX_BUYER_PASSWORD!),
          "the buyer's password",
        ).toBe(true);
        await expect(sandbox).toContainText("4462 6030 4234 3024");
        await expect(sandbox).toContainText("12/30");
      },
    );
  });

  test("two sessions never see each other's cases", async ({ playwright, baseURL }) => {
    await inOwnBrowser(
      () => playwright.chromium.launch({ headless: true }),
      async (browser) => {
        const judges = await Promise.all(
          [0, 1].map(async () => {
            const context = await browser.newContext(visitor(baseURL));
            const page = await context.newPage();
            await page.goto("/");
            await page.getByRole("link", { name: "Try it as the practice" }).click();
            await expect(page.getByRole("heading", { name: "Today's cases" })).toBeVisible();
            const links = page.getByRole("main").getByRole("link", { name: /^[A-Z][a-z]+$/ });
            const cases = await links.evaluateAll((found) =>
              found.map((link) => [link.textContent ?? "", link.getAttribute("href") ?? ""]),
            );
            return { page, cases: new Map(cases.map(([name, href]) => [name!, href!])) };
          }),
        );
        const [first, second] = judges as [(typeof judges)[0], (typeof judges)[0]];

        expect([...first.cases.keys()].sort()).toEqual([...second.cases.keys()].sort());
        expect(first.cases.size).toBeGreaterThanOrEqual(15);
        const firstHrefs = new Set(first.cases.values());
        for (const href of second.cases.values()) {
          expect(href).toMatch(/^\/cases\/[0-9a-f-]{36}$/);
          expect(firstHrefs.has(href), href).toBe(false);
        }

        const theirs = second.cases.get("Bramble")!;
        const answer = await first.page.goto(theirs);
        expect(answer?.status()).toBe(404);
        const mine = await second.page.goto(theirs);
        expect(mine?.status()).toBe(200);
        await expect(second.page.getByRole("heading", { level: 1, name: "Bramble" })).toBeVisible();
      },
    );
  });
});

test.describe("the landing page", () => {
  test("declares an icon that the server serves, so no browser asks for a missing favicon", async ({
    page,
  }) => {
    await page.goto("/");
    const href = await page.locator("head link[rel~='icon']").first().getAttribute("href");

    expect(href).not.toBeNull();
    const icon = await page.request.get(href!);
    expect(icon.status()).toBe(200);
    expect((await page.request.get("/favicon.ico")).status()).toBe(200);
  });
});

/**
 * The landing page and each door's first screen, full page at both widths,
 * for the handover: run with SHOTS_DIR set (`SHOTS_DIR=... pnpm test:browser
 * judge`); skipped otherwise.
 */
const directory = process.env.SHOTS_DIR;

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`judge mode's shots at ${WIDTHS[width].width} px`, () => {
    test.use({ width });
    test.skip(!directory, "SHOTS_DIR is not set");

    test("the landing page and both doors' first screens", async ({ page }) => {
      const px = WIDTHS[width].width;
      const shoot = (name: string) =>
        page.screenshot({ path: join(directory!, `${name}-${px}.png`), fullPage: true });

      await page.goto("/");
      await shoot("landing");
      await page.getByRole("link", { name: "Try it as the owner" }).click();
      await expect(
        page.getByRole("complementary", { name: "Testing in PayPal's sandbox" }),
      ).toBeVisible();
      await shoot("owner-door");
      await page.goto("/");
      await page.getByRole("link", { name: "Try it as the practice" }).click();
      await expect(page.getByRole("link", { name: "Otis" })).toBeVisible();
      await shoot("practice-door");
    });
  });
}
