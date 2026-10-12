import { expect, test } from "@playwright/test";

import { OWNER_LINK_LIFETIME_MS } from "@/owner/link";

import { openBrowserDatabase, sentBrambleEstimate } from "./support/cases";
import { expectNoSeriousViolations, expectTargetsAtLeast44 } from "./support/checks";
import { saveShot } from "./support/shots";

const database = openBrowserDatabase();

test.afterAll(async () => {
  await database.close();
});

test.describe("the owner's link", () => {
  test("an expired or tampered link shows the ask-the-practice page", async ({ page }) => {
    const expired = await sentBrambleEstimate(
      database.db,
      new Date(Date.now() - OWNER_LINK_LIFETIME_MS - 60_000),
    );
    await page.goto(expired.path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link has expired");
    await expect(
      page.getByText("Ask Hollins Lane Veterinary Surgery to send it again."),
    ).toBeVisible();
    await expectNoSeriousViolations(page);
    await expectTargetsAtLeast44(page);
    await saveShot(page, "ask-the-practice");

    const sent = await sentBrambleEstimate(database.db);
    const at = 20;
    const tampered = `${sent.token.slice(0, at)}${sent.token[at] === "A" ? "B" : "A"}${sent.token.slice(at + 1)}`;
    await page.goto(`/e/${tampered}`);
    await expect(page.getByText("Ask the practice that sent it to send it again.")).toBeVisible();
    await expect(page.getByText("Hollins Lane")).toHaveCount(0);
    await expect(page.getByText("Bramble")).toHaveCount(0);
  });

  test("a valid link opens the estimate it was sent with", async ({ page }) => {
    const sent = await sentBrambleEstimate(database.db);
    await page.goto(sent.path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Bramble's estimate from Hollins Lane Veterinary Surgery",
    );
  });
});
