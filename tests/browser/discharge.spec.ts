import { expect, signInAsPractice, test, WIDTHS, type Width } from "./fixtures";

/*
 * The discharge page (U7), walked at 1440 and 390 px. The seeded showcase
 * case Bramble is held on a seeded hold (its PayPal ids are not PayPal's),
 * so its bill can be made and judged but never charged.
 */

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`at ${WIDTHS[width].width} px`, () => {
    test.use({ width });

    test("the bill lists the approved lines at the estimate's low, refuses work off the estimate and a quantity above the approval", async ({
      page,
    }) => {
      await signInAsPractice(page);
      await page.goto("/today");
      await page.getByRole("link", { name: "Bramble" }).click();
      await page.getByRole("link", { name: "Discharge" }).click();

      await expect(page.getByRole("heading", { level: 1, name: "Itemised bill" })).toBeVisible();
      const approved = page.getByRole("region", { name: "Approved with the estimate" });
      await expect(approved.getByRole("listitem")).toHaveCount(7);
      await expect(
        approved.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }),
      ).toHaveValue("0");
      const total = page.getByRole("region", { name: "Total" });
      await expect(total.getByRole("definition").first()).toHaveText("£731.00");
      await expect(total.getByRole("definition").nth(1)).toHaveText("£927.00");

      await approved.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }).fill("3");
      await expect(
        approved.getByText("3 done, 2 approved. Send an update to charge the rest."),
      ).toBeVisible();

      const extra = page.getByRole("region", { name: "Work not on an approved estimate" });
      await extra.getByLabel("Item").selectOption({ index: 1 });
      await extra.getByRole("button", { name: "Note the work" }).click();
      await expect(
        extra.getByText("Not on an approved estimate. Send an update to charge it."),
      ).toBeVisible();
      await expect(extra.getByText(/not charged$/)).toBeVisible();
    });
  });
}
