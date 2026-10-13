import { expect, signInAsPractice, test, WIDTHS, type Width } from "./fixtures";
import { expectFraunces, expectSystemStack } from "./support/type";

/*
 * The restyle on the landing page and the practice's screens (U16): the
 * landing heading in Fraunces, everything the practice reads in the system
 * stack, and what the restyle must leave as it was: the money chips'
 * colours and the focus ring.
 */

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`at ${WIDTHS[width].width} px`, () => {
    test.use({ width });

    test("the landing heading is in Fraunces and its sentence and doors in the system stack", async ({
      page,
    }) => {
      await page.goto("/");

      await expectFraunces(
        page.getByRole("heading", { level: 1, name: "Estimates your clients can say yes to." }),
      );
      await expectSystemStack(page.getByText("Sandbox only: no real money moves."));
      await expectSystemStack(page.getByRole("link", { name: "Try it as the practice" }));
      await expect(page.locator('link[rel="preload"][as="font"]')).not.toHaveCount(0);
    });

    test("today's cases are all in the system stack, their chips in the money colours they had", async ({
      page,
    }) => {
      await signInAsPractice(page);
      await page.goto("/today");

      await expectSystemStack(page.getByRole("heading", { level: 1, name: "Today's cases" }));
      // The practice's working screens never draw Fraunces, so never fetch it.
      await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(0);
      const row = page.getByRole("listitem").filter({ hasText: "Hazel" });
      const held = row.getByText(/^Held £/);
      await expectSystemStack(held);
      await expect(held).toHaveCSS("background-color", "rgb(220, 233, 251)");
      await expect(held).toHaveCSS("color", "rgb(19, 63, 120)");
      const declined = page
        .getByRole("listitem")
        .filter({ hasText: "Bramble" })
        .getByText("Update declined", { exact: true });
      await expect(declined).toHaveCSS("background-color", "rgb(251, 224, 220)");
      await expect(declined).toHaveCSS("color", "rgb(126, 31, 22)");
    });

    test("the focus ring is the blue it was, outside the element", async ({ page }) => {
      await signInAsPractice(page);
      await page.goto("/today");

      const button = page.getByRole("button", { name: "New case" });
      await button.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");

      await expect(button).toBeFocused();
      await expect(button).toHaveCSS("outline-color", "rgb(29, 95, 191)");
      await expect(button).toHaveCSS("outline-style", "solid");
      await expect(button).toHaveCSS("outline-width", "3px");
    });
  });
}
