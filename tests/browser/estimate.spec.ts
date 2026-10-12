import { expect, openNewCase, PLAN_NOTES, signInAsPractice, test } from "./fixtures";

test("draft, edit a line, send", async ({ page }) => {
  await signInAsPractice(page);
  await openNewCase(page, { patient: "Pepper", owner: "Sam Patel", procedure: "Dental" });

  await page.getByRole("textbox", { name: "Clinical notes" }).fill(PLAN_NOTES);
  await page.getByRole("button", { name: "Draft estimate" }).click();

  const draft = page.getByRole("region", { name: "Draft estimate, version 1" });
  await expect(
    draft.getByText('From your notes: "probable two extractions upper PM"'),
  ).toBeVisible();
  await expect(draft.getByText("Only if: extractions are needed")).toBeVisible();
  const notes = page.getByRole("region", { name: "Clinical notes" });
  await expect(notes.locator("mark")).toHaveText([
    "GA1",
    "dental scale and polish2",
    "probable two extractions upper PM3",
    "pre-op bloods4",
  ]);
  // The closed review dialog repeats the total; the page's own comes first.
  await expect(
    draft.getByText("Estimate £577.00 to £667.00. The hold will be £667.00.").first(),
  ).toBeVisible();

  const line3 = draft.locator("details", { hasText: "Change line 3" });
  await line3.getByText("Change line 3").click();
  await line3.getByLabel("Most").fill("3");
  await line3.getByRole("button", { name: "Save line 3" }).click();
  await expect(draft.getByText("0 to 3 at £45.00 per tooth")).toBeVisible();
  // The closed review dialog repeats the total; the page's own comes first.
  await expect(
    draft.getByText("Estimate £577.00 to £712.00. The hold will be £712.00.").first(),
  ).toBeVisible();

  await draft.getByRole("button", { name: "Send to Sam" }).click();
  const review = page.getByRole("dialog", { name: "Send this estimate to Sam?" });
  await expect(review.getByRole("list", { name: "What Sam will see" })).toContainText(
    "Removal of up to two upper premolar teeth",
  );
  await expect(review).toContainText("Sending records your approval of every line as Rowan Hale.");
  await review.getByRole("button", { name: "Send to Sam" }).click();

  await expect(page.getByRole("status")).toHaveText(
    "Sent. Sam can authorise the hold from the link on their phone.",
  );
  await expect(page.getByText("Waiting for owner", { exact: true })).toBeVisible();
  await expect(page.getByText("Waiting for Sam to authorise the hold of £712.00.")).toBeVisible();
});

test("adds items by hand when there is no draft, and refuses an amount in the owner's wording", async ({
  page,
}) => {
  await signInAsPractice(page);
  await openNewCase(page, { patient: "Mochi", owner: "Lee Wong", procedure: "Consult" });

  await page.getByLabel("Item").selectOption("CON-STD");
  await page.getByRole("button", { name: "Add the item" }).click();
  const draft = page.getByRole("region", { name: "Draft estimate, version 1" });
  await expect(draft.getByRole("list", { name: "Lines of version 1" })).toContainText(
    "Consultation, 15 minutes",
  );

  await draft.getByText("Change line 1").click();
  await draft.getByLabel("What the owner reads").fill("A consultation, £52");
  await draft.getByRole("button", { name: "Save line 1" }).click();
  await expect(draft.getByLabel("What the owner reads")).toHaveAttribute("aria-invalid", "true");
  await expect(draft).toContainText(
    "The owner's wording can't carry an amount, a percentage or a dose: prices come from your list.",
  );
});
