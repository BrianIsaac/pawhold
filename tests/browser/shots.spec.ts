import { join } from "node:path";

import { expect, signInAsPractice, test, WIDTHS, type Width } from "./fixtures";

/**
 * Full-page shots of each practice screen at both widths, for the handover
 * and for reading the pixels by eye: run with SHOTS_DIR set to the folder to
 * write them to (`SHOTS_DIR=... pnpm test:browser shots`); skipped otherwise.
 */
const directory = process.env.SHOTS_DIR;

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`shots at ${WIDTHS[width].width} px`, () => {
    test.use({ width });
    test.skip(!directory, "SHOTS_DIR is not set");

    test("today's cases", async ({ page }) => {
      await signInAsPractice(page);
      await page.goto("/today");
      await expect(page.getByRole("link", { name: "Bramble" })).toBeVisible();
      await page.screenshot({
        path: join(directory!, `today-${WIDTHS[width].width}.png`),
        fullPage: true,
      });
    });

    test("the seeded case", async ({ page }) => {
      await signInAsPractice(page);
      await page.goto("/today");
      await page.getByRole("link", { name: "Bramble" }).click();
      await expect(page).toHaveURL(/\/cases\//);
      await page.screenshot({
        path: join(directory!, `case-seeded-${WIDTHS[width].width}.png`),
        fullPage: true,
      });
    });
  });
}
