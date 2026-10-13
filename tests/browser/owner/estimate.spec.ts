import { expect, test } from "@playwright/test";

import { openBrowserDatabase, sentBrambleEstimate } from "./support/cases";
import {
  expectNoSeriousViolations,
  expectTargetsAtLeast44,
  untilPayPalDrawn,
} from "../support/checks";
import { saveShot } from "./support/shots";

const database = openBrowserDatabase();

test.afterAll(async () => {
  await database.close();
});

test.describe("the estimate page", () => {
  test("shows the lines in the owner's words beside the vet's notes, the range and the hold", async ({
    page,
  }) => {
    const sent = await sentBrambleEstimate(database.db);
    await page.goto(sent.path);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Bramble's estimate from Hollins Lane Veterinary Surgery",
    );
    await expect(
      page.getByText(
        "This is what Rowan Hale expects Bramble's treatment to cost. Nothing is charged now: PayPal holds up to £927.00, and you'll only pay for what's done.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Likely £731.00 to £927.00, depending on what Rowan Hale finds."),
    ).toBeVisible();
    await expect(
      page.getByText(
        "If Rowan Hale finds something that needs more, they'll ask you first. Nothing above £927.00 is charged without your yes.",
      ),
    ).toBeVisible();

    const lines = page
      .getByRole("list", { name: "What the estimate covers" })
      .getByRole("listitem");
    await expect(lines).toHaveCount(7);
    const extraction = lines.filter({ hasText: "Removing up to two damaged back teeth" });
    await expect(extraction).toContainText("£0.00 to £196.00");
    await expect(extraction).toContainText(
      "Only if: the X-rays show the upper back teeth need to come out",
    );
    const notes = extraction.getByText("Probable 2 surgical extractions upper PM4s");
    await expect(notes).toBeHidden();
    await extraction.getByText("What the vet wrote").click();
    await expect(notes).toBeVisible();
    await expect(lines.filter({ hasText: "A blood test before the anaesthetic" })).toContainText(
      "£72.00",
    );

    await untilPayPalDrawn(page);
    await expectNoSeriousViolations(page, ["iframe"]);
    await expectTargetsAtLeast44(page);
    await saveShot(page, "estimate");
  });
});
