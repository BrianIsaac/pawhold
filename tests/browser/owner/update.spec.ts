import { eq } from "drizzle-orm";
import { expect, test } from "@playwright/test";

import { hold, patientCase } from "@/db/schema";

import { BRAMBLE_EXPLANATION, brambleUpdate, openBrowserDatabase } from "./support/cases";
import {
  expectNoSeriousViolations,
  expectTargetsAtLeast44,
  untilPayPalDrawn,
} from "./support/checks";
import { saveShot } from "./support/shots";

const database = openBrowserDatabase();

test.afterAll(async () => {
  await database.close();
});

test.describe("the update page", () => {
  test("a declined update leaves the case held at its first estimate", async ({ page }) => {
    const { first, update } = await brambleUpdate(database.db);
    await page.goto(update.path);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Rowan Hale found something and is asking before going ahead.",
    );
    await expect(page.getByText(BRAMBLE_EXPLANATION)).toBeVisible();
    const added = page.getByRole("list", { name: "What this adds" }).getByRole("listitem");
    await expect(added).toHaveCount(2);
    await expect(added.filter({ hasText: "Removing up to four damaged teeth" })).toContainText(
      "£0.00 to £392.00",
    );
    await expect(added.filter({ hasText: "Antibiotic tablets for a week" })).toContainText(
      "£32.00",
    );
    await expect(page.getByText("This adds £228.00 to Bramble's estimate.")).toBeVisible();
    await expect(page.getByText("The practice will call you to talk it through.")).toBeVisible();
    await untilPayPalDrawn(page);
    await expectNoSeriousViolations(page, ["iframe"]);
    await expectTargetsAtLeast44(page);
    await saveShot(page, "update");

    await page.getByRole("button", { name: "Don't go ahead" }).click();

    await expect(
      page.getByText(
        "You said not to go ahead. The practice will call you to talk it through. The £927.00 already held stays as it is.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Don't go ahead" })).toHaveCount(0);
    await expectNoSeriousViolations(page);
    await saveShot(page, "update-declined");
    const [kase] = await database.db
      .select({ state: patientCase.moneyState })
      .from(patientCase)
      .where(eq(patientCase.id, update.caseId));
    expect(kase!.state).toBe("update_declined");
    const holds = await database.db.select().from(hold).where(eq(hold.caseId, update.caseId));
    expect(holds.map((one) => [one.id, one.status, one.amountPence])).toEqual([
      [first.versionId, "authorised", 92_700],
    ]);

    await page.goto(first.path);
    await expect(
      page.getByText(
        "Done. £927.00 is held on your PayPal. You'll get the final bill at discharge.",
      ),
    ).toBeVisible();
    await expect(page.getByText(/^Confirmed by PayPal \d{2}:\d{2}:\d{2}$/)).toBeVisible();
  });
});
