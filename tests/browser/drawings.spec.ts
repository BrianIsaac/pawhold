import { join } from "node:path";

import type { Page } from "@playwright/test";

import { signSessionId, SESSION_COOKIE, startJudgeSession } from "@/judge/session";

import { expect, signInAsPractice, test, WIDTHS, type Width } from "./fixtures";
import { browserSecret, openBrowserDatabase } from "./owner/support/cases";
import { checkScreen } from "./support/checks";
import { londonDay } from "./support/day";
import { expectFraunces, expectSystemStack } from "./support/type";

/*
 * The drawings on the landing page and the practice's empty states (U18,
 * the restyle's mock-ups): the landing's sage band with the heading in
 * Fraunces and a dog and a cat, its two doors as cards at the panel's
 * radius each with its drawing on a mint disc; a cat asleep above Today's
 * empty list and a dog asleep above an empty day, their words in the system
 * stack. Shots for the handover when SHOTS_DIR is set.
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

/**
 * Signs the page in to a practice of its own with no cases at all, as a
 * judge's would be had its seed made none. The practice's walks run fully
 * parallel, so a worker can close a file's shared handle and then take
 * another of its tests: the database is opened for this call alone.
 *
 * @param page - The page.
 */
async function signInToAnEmptyPractice(page: Page): Promise<void> {
  const database = openBrowserDatabase();
  let started: Awaited<ReturnType<typeof startJudgeSession>>;
  try {
    started = await startJudgeSession({ db: database.db }, "practice");
  } finally {
    await database.close();
  }
  await page.goto("/");
  await page.context().addCookies([
    {
      name: SESSION_COOKIE,
      value: signSessionId(started.sessionId, browserSecret()),
      url: new URL(page.url()).origin,
    },
  ]);
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

    test("today's cases with none yet: a cat asleep above the words", async ({ page }) => {
      await signInToAnEmptyPractice(page);
      await page.goto("/today");

      const words = page.getByText("No cases yet. Open one to draft its estimate.");
      await expect(words).toBeVisible();
      await expectSystemStack(words);
      await expect(
        page.getByRole("img", { name: "A line drawing of a cat, asleep" }),
      ).toBeVisible();
      // The practice's working screens never draw Fraunces, so never fetch it.
      await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(0);

      await checkScreen(page);
      await expectNoOverflow(page);
      if (shots) {
        await page.screenshot({ path: join(shots, `today-empty-${px}.png`), fullPage: true });
      }
    });

    test("a day with nothing booked: a dog asleep above the words", async ({ page }) => {
      await signInAsPractice(page);
      await page.goto(`/day?day=${londonDay(30 * 24 * 60)}`);

      const words = page.getByText(/^Nothing is booked on/);
      await expect(words).toBeVisible();
      await expectSystemStack(words);
      await expect(
        page.getByRole("img", { name: "A line drawing of a dog, asleep" }),
      ).toBeVisible();

      await checkScreen(page);
      await expectNoOverflow(page);
      if (shots) {
        await page.screenshot({ path: join(shots, `day-empty-${px}.png`), fullPage: true });
      }
    });
  });
}
