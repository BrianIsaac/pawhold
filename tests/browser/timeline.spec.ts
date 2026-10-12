import { expect, signInAsPractice, test } from "./fixtures";

test("the timeline shows every audit event of a seeded case in order", async ({ page }) => {
  await signInAsPractice(page);
  await page.goto("/today");
  await page.getByRole("link", { name: "Bramble" }).click();

  const timeline = page.getByRole("region", { name: "Timeline" });
  const lines = timeline.locator("li > p");
  await expect(lines).toHaveText([
    /^\d\d:\d\d Rowan Hale: opened the case for BrambleSeeded for the demo$/,
    /^\d\d:\d\d Rowan Hale: made version 1 of the estimate, £731\.00 to £927\.00Seeded for the demo$/,
    /^\d\d:\d\d Rowan Hale: approved version 1Seeded for the demo$/,
    /^\d\d:\d\d Rowan Hale: sent the estimate to Nadia: £731\.00 to £927\.00, a hold of £927\.00Seeded for the demo$/,
    /^\d\d:\d\d Owner: opened PayPal's checkout for a hold of £927\.00Seeded for the demo$/,
    /^\d\d:\d\d Owner: authorised a hold of £927\.00 \(PayPal\)Seeded for the demo$/,
    /^\d\d:\d\d Rowan Hale: made version 2 of the estimate, £951\.00 to £1,147\.00Seeded for the demo$/,
    /^\d\d:\d\d Rowan Hale: approved version 2Seeded for the demo$/,
    /^\d\d:\d\d Rowan Hale: sent an update to Nadia: the estimate is now £951\.00 to £1,147\.00Seeded for the demo$/,
    /^\d\d:\d\d Owner: opened PayPal's checkout for a hold of £220\.00Seeded for the demo$/,
    /^\d\d:\d\d Owner: declined the updateSeeded for the demo$/,
    /^\d\d:\d\d pawhold: extended the hold of £927\.00: PayPal reauthorised itSeeded for the demo$/,
  ]);

  const authorised = timeline.getByRole("listitem").filter({ hasText: "authorised a hold" });
  await authorised.getByText("Show PayPal and model details").click();
  await expect(
    authorised.getByRole("definition").filter({ hasText: /^SEEDED[0-9A-F]{10}$/ }),
  ).toHaveCount(2);
  await expect(authorised).toContainText("awaiting owner to held");
});
