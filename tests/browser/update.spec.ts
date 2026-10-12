import { WALK_FINDING, WALK_PHOTO_PATH } from "../support/update-walk-words";
import { expect, signInAsPractice, test } from "./fixtures";

test("add an update with a photo, see the trigger sentence, send", async ({ page }) => {
  await signInAsPractice(page);
  await page.goto("/today");
  await page.getByRole("link", { name: "Bramble" }).click();

  const update = page.getByRole("region", { name: "Update", exact: true });
  await expect(update.getByText(/^Nadia declined this update on \w+day \d+ \w+\./)).toBeVisible();

  const form = update.getByRole("region", { name: "Add an update" });
  await form.getByLabel("What did you find, and what do you recommend?").fill(WALK_FINDING);
  await form.getByLabel("Add a photo").setInputFiles(WALK_PHOTO_PATH);
  await form.getByLabel("Show the photo to the owner").check();
  await form.getByRole("button", { name: "Draft the update" }).click();

  const draft = update.getByRole("region", { name: "Update, version 3" });
  await expect(draft.getByRole("list", { name: "Lines of version 3" })).toContainText(
    "Removing the infected back tooth",
  );
  await expect(draft.getByText('From your notes: "Antibiotics to go home"')).toBeVisible();
  const photo = update.getByRole("img", { name: "The photo added to the update for Bramble" });
  await expect(photo).toBeVisible();
  expect(await photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(96);
  await expect(update.getByText("Nadia sees this photo.")).toBeVisible();
  await expect(update).toContainText(
    "Rowan found an infection at the root of one of Bramble's upper back teeth on the X-ray.",
  );
  await expect(draft.getByText(/^This adds £130.00/)).toHaveText(
    "This adds £130.00, 14% over the held estimate. The CMA's Order asks for an updated written estimate at 20% or £500.00, whichever is lower: this one does not meet it. pawhold asks the owner either way, because nothing over the hold is charged without their yes.",
  );

  await draft.getByRole("button", { name: "Ask Nadia to approve £130.00" }).click();
  const confirm = page.getByRole("dialog", { name: "Ask Nadia to approve the update?" });
  await confirm.getByRole("button", { name: "Ask Nadia to approve £130.00" }).click();

  await expect(page.getByRole("status")).toHaveText(
    "Sent. Nadia can approve the update from the link on their phone.",
  );
  await expect(page.getByText("Update waiting", { exact: true })).toBeVisible();
  await expect(page.getByText("Waiting for Nadia to approve £130.00.")).toBeVisible();
});
