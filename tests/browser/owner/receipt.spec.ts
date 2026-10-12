import { expect, test } from "@playwright/test";

import { dischargedCase, DOUBLE_URL, receiptPath, refundAtTheDouble } from "../support/discharge";
import { brambleCase, openBrowserDatabase, refundedBramble } from "./support/cases";
import { expectNoSeriousViolations, expectTargetsAtLeast44 } from "./support/checks";
import { saveShot } from "./support/shots";

const database = openBrowserDatabase();

test.afterAll(async () => {
  await database.close();
});

test.describe("the receipt", () => {
  test("a discharged and refunded case shows what was paid from which approval and what was released", async ({
    page,
  }) => {
    const { first, update } = await refundedBramble(database.db);
    await page.goto(first.path);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Bramble's receipt from Hollins Lane Veterinary Surgery",
    );
    // £927.00 + £228.00 held; the bill £1,057.00; released £98.00; £25.00 refunded.
    await expect(
      page.getByText(
        "You paid £1,032.00 for Bramble's treatment. £98.00 of what was held has been released.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("That is £1,057.00 charged at discharge, less £25.00 refunded to you."),
    ).toBeVisible();
    const lines = page.getByRole("list", { name: "Itemised bill" }).getByRole("listitem");
    await expect(lines).toHaveCount(9);
    await expect(lines.filter({ hasText: "Removing up to four damaged teeth" })).toContainText(
      "3 at £98.00 each",
    );
    await expect(lines.last()).toContainText("£1,057.00");
    await expect(
      page.getByText(
        "Paid from your first approval: £927.00. Paid from your second approval: £130.00.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Released holds can take a few days to disappear from your statement."),
    ).toBeVisible();
    await expectNoSeriousViolations(page);
    await expectTargetsAtLeast44(page);
    await saveShot(page, "receipt");

    await page.goto(update.path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Bramble's receipt from Hollins Lane Veterinary Surgery",
    );
  });

  test("a refund after discharge appears on the receipt", async ({ page }) => {
    test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
    // Discharged and refunded by U7's own functions against U3's PayPal double.
    const { practiceId } = await brambleCase(database.db);
    const kase = await dischargedCase(database.db, practiceId);
    await refundAtTheDouble(database.db, kase, "40.00", "Correction: one line charged twice");

    await page.goto(await receiptPath(database.db, kase));

    await expect(
      page.getByText(
        "You paid £1,017.00 for Pepper's treatment. £98.00 of what was held has been released.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("That is £1,057.00 charged at discharge, less £40.00 refunded to you."),
    ).toBeVisible();
    await expectNoSeriousViolations(page);
    await expectTargetsAtLeast44(page);
  });
});
