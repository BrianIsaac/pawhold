import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test, WIDTHS, type Width } from "./fixtures";
import { checkScreen } from "./support/checks";
import { expectFraunces } from "./support/type";

/*
 * The drawings on the landing page (U18, the restyle's mock-ups): the
 * landing's sage band with the heading in Fraunces and a dog and a cat, its
 * two doors as cards at the panel's radius each with its drawing on a mint
 * disc. Shots for the handover when SHOTS_DIR is set.
 */

const shots = process.env.SHOTS_DIR;

/**
 * Fails when the page runs wider than its window.
 *
 * @param page - The page.
 */
async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
}

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`the drawings at ${WIDTHS[width].width} px`, () => {
    test.use({ width });
    const px = WIDTHS[width].width;

    test("the landing page: a sage band with a dog and a cat, and two doors as cards", async ({
      page,
    }) => {
      await page.goto("/");

      const heading = page.getByRole("heading", {
        level: 1,
        name: "Estimates your clients can say yes to.",
      });
      await expectFraunces(heading);
      await expect(heading).toHaveCSS("color", "rgb(139, 93, 51)");
      // Saddle on sage is 3.3:1: the heading is large text at every width.
      const size = await heading.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
      expect(size).toBeGreaterThanOrEqual(40);
      const band = heading.locator("xpath=ancestor::div[3]");
      await expect(band).toHaveCSS("background-color", "rgb(167, 205, 189)");
      await expect(
        page.getByRole("img", { name: "A line drawing of a dog, sitting" }),
      ).toBeVisible();
      await expect(
        page.getByRole("img", { name: "A line drawing of a cat, sitting" }),
      ).toBeVisible();

      const doors = page.getByRole("navigation", { name: "Try pawhold" });
      for (const [door, drawing] of [
        ["Try it as the practice", "A line drawing of a stethoscope"],
        ["Try it as the owner", "A line drawing of a phone with a paw print on its screen"],
      ] as const) {
        const card = doors.locator("> div").filter({ has: page.getByRole("link", { name: door }) });
        await expect(card).toHaveCSS("border-radius", "24px");
        await expect(card.getByRole("img", { name: drawing })).toBeVisible();
      }

      await checkScreen(page);
      await expectNoOverflow(page);
      if (shots) {
        await page.screenshot({ path: join(shots, `landing-${px}.png`), fullPage: true });
      }
    });
  });
}
