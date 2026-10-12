import { join } from "node:path";

import { openBrowserDatabase } from "./owner/support/cases";
import {
  deliverDischargeWebhooks,
  dischargedCase,
  DOUBLE_URL,
  receiptPath,
  twoHoldCase,
} from "./support/discharge";
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
    test("the seeded case's bill, a line above its approval and work off the estimate", async ({
      page,
    }) => {
      const px = WIDTHS[width].width;
      await signInAsPractice(page);
      await page.goto("/today");
      await page.getByRole("link", { name: "Bramble" }).click();
      await page.getByRole("link", { name: "Discharge" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Itemised bill" })).toBeVisible();
      await page.screenshot({
        path: join(directory!, `discharge-seeded-${px}.png`),
        fullPage: true,
      });
      await page.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }).fill("3");
      const extra = page.getByRole("region", { name: "Work not on an approved estimate" });
      await extra.getByLabel("Item").selectOption({ index: 1 });
      await extra.getByRole("button", { name: "Note the work" }).click();
      await expect(extra.getByText(/not charged$/)).toBeVisible();
      await expect(
        page.getByText("3 done, 2 approved. Send an update to charge the rest."),
      ).toBeVisible();
      await page.screenshot({
        path: join(directory!, `discharge-refused-${px}.png`),
        fullPage: true,
      });
    });
    test("a two-hold case's bill, confirmed, landing and confirmed by PayPal", async ({ page }) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      const px = WIDTHS[width].width;
      const practiceId = await signInAsPractice(page);
      const database = openBrowserDatabase();
      try {
        const kase = await twoHoldCase(database.db, practiceId);
        await page.goto(`/cases/${kase.caseId}/discharge`);
        await page
          .getByRole("region", { name: "Approved with the update" })
          .getByRole("textbox", { name: "Done: Tooth extraction, surgical" })
          .fill("3");
        await expect(page.locator("#bill-verdict").getByText(/will be captured/)).toBeVisible();
        await page.screenshot({
          path: join(directory!, `discharge-bill-${px}.png`),
          fullPage: true,
        });
        await page.getByRole("button", { name: "Confirm and charge £1,057.00" }).click();
        await expect(page.getByRole("dialog", { name: "Confirm the bill?" })).toBeVisible();
        await page.screenshot({ path: join(directory!, `discharge-confirm-${px}.png`) });
        await page
          .getByRole("dialog", { name: "Confirm the bill?" })
          .getByRole("button", { name: "Confirm and charge £1,057.00" })
          .click();
        await expect(page.getByRole("region", { name: "Discharged" })).toBeVisible({
          timeout: 20_000,
        });
        await page.screenshot({
          path: join(directory!, `discharge-landed-${px}.png`),
          fullPage: true,
        });
        await deliverDischargeWebhooks(database.db, kase.caseId);
        await expect(page.getByText(/^Confirmed by PayPal/)).toHaveCount(3, { timeout: 10_000 });
        await page.screenshot({
          path: join(directory!, `discharge-confirmed-${px}.png`),
          fullPage: true,
        });
      } finally {
        await database.close();
      }
    });
    test("a discharged case refunded in part, and the owner's receipt", async ({ page }) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      const px = WIDTHS[width].width;
      const practiceId = await signInAsPractice(page);
      const database = openBrowserDatabase();
      try {
        const kase = await dischargedCase(database.db, practiceId);
        await page.goto(`/cases/${kase.caseId}`);
        await page
          .getByRole("region", { name: "Refund" })
          .getByRole("button", { name: "Refund" })
          .click();
        const dialog = page.getByRole("dialog", { name: "Refund Sam?" });
        await dialog.getByLabel("Amount").fill("25.00");
        await dialog.getByLabel("Why").fill("Goodwill: the discharge ran late");
        await page.screenshot({ path: join(directory!, `refund-dialog-${px}.png`) });
        await dialog.getByRole("button", { name: "Refund" }).click();
        await expect(page.getByRole("status")).toBeVisible();
        await page.screenshot({ path: join(directory!, `refund-case-${px}.png`), fullPage: true });
        await page.goto(await receiptPath(database.db, kase));
        await expect(page.getByText(/less £25\.00 refunded to you/)).toBeVisible();
        await page.screenshot({
          path: join(directory!, `refund-receipt-${px}.png`),
          fullPage: true,
        });
      } finally {
        await database.close();
      }
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
