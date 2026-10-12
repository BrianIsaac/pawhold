import { join } from "node:path";

import { WALK_FINDING, WALK_PHOTO_PATH } from "../support/update-walk-words";
import {
  expect,
  openNewCase,
  PLAN_NOTES,
  signInAsPractice,
  test,
  WIDTHS,
  type Width,
} from "./fixtures";

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
    test("a case drafted from its notes, then sent", async ({ page }) => {
      const px = WIDTHS[width].width;
      await signInAsPractice(page);
      await openNewCase(page, { patient: "Pepper", owner: "Sam Patel", procedure: "Dental" });
      await page.screenshot({ path: join(directory!, `case-new-${px}.png`), fullPage: true });
      await page.getByRole("textbox", { name: "Clinical notes" }).fill(PLAN_NOTES);
      await page.getByRole("button", { name: "Draft estimate" }).click();
      await expect(page.getByRole("region", { name: "Draft estimate, version 1" })).toBeVisible();
      await page.screenshot({ path: join(directory!, `case-draft-${px}.png`), fullPage: true });
      await page.getByRole("button", { name: "Send to Sam" }).click();
      await page.screenshot({ path: join(directory!, `case-review-${px}.png`) });
      await page
        .getByRole("dialog", { name: "Send this estimate to Sam?" })
        .getByRole("button", { name: "Send to Sam" })
        .click();
      await expect(page.getByRole("status")).toBeVisible();
      await page.screenshot({ path: join(directory!, `case-sent-${px}.png`), fullPage: true });
    });
    test("an update drafted with its photo, then sent", async ({ page }) => {
      const px = WIDTHS[width].width;
      await signInAsPractice(page);
      await page.goto("/today");
      await page.getByRole("link", { name: "Bramble" }).click();
      const form = page.getByRole("region", { name: "Add an update" });
      await form.getByLabel("What did you find, and what do you recommend?").fill(WALK_FINDING);
      await form.getByLabel("Add a photo").setInputFiles(WALK_PHOTO_PATH);
      await form.getByLabel("Show the photo to the owner").check();
      await form.getByRole("button", { name: "Draft the update" }).click();
      await expect(page.getByRole("region", { name: "Update, version 3" })).toBeVisible();
      await page.screenshot({
        path: join(directory!, `case-update-draft-${px}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Ask Nadia to approve £130.00" }).click();
      await page
        .getByRole("dialog", { name: "Ask Nadia to approve the update?" })
        .getByRole("button", { name: "Ask Nadia to approve £130.00" })
        .click();
      await expect(page.getByRole("status")).toBeVisible();
      await page.screenshot({
        path: join(directory!, `case-update-sent-${px}.png`),
        fullPage: true,
      });
    });
  });
}
