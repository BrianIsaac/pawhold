import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, signInAsPractice, test, WIDTHS, type Width } from "./fixtures";

/** The smallest a tap target may be, each way (plan 5, U5's acceptance). */
const TARGET_PX = 44;

/** The seeded day's patients: the showcase case's check and the day's seven cases. */
const SEEDED_PATIENTS = ["Archie", "Biscuit", "Bramble", "Clover", "Juno", "Moss", "Pip", "Willow"];

/** Full-page shots for the handover when set (`SHOTS_DIR=... pnpm test:browser day`). */
const shots = process.env.SHOTS_DIR;

/**
 * The calendar day in London of an instant some minutes from now.
 *
 * @param minutes - Minutes from now.
 * @returns "2026-10-12".
 */
function londonDay(minutes: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + minutes * 60 * 1000));
}

/**
 * Signs in as a new seeded practice and opens the day its case due inside the
 * lead time falls on, once the agent's first check has held its slot.
 *
 * @param page - The page.
 * @returns The held slot's start, as the proposal names it ("16:30").
 */
async function openHeldDay(page: Page): Promise<string> {
  await signInAsPractice(page);
  await page.goto(`/day?day=${londonDay(30)}`);
  const held = page.getByRole("region", { name: "Held by pawhold" });
  await expect(held).toBeVisible();
  const title = await held.getByRole("heading", { level: 3 }).first().textContent();
  const slot = /^Theatre 1, (\d\d:\d\d): Juno$/.exec(title ?? "")?.[1];
  expect(slot, title ?? "").toBeDefined();
  return slot!;
}

/**
 * A booking's link on the grid, by its patient.
 *
 * @param page - The page.
 * @param patient - The patient.
 * @returns The link.
 */
function bookingOf(page: Page, patient: string) {
  return page
    .getByRole("region", { name: "Bookings by room" })
    .getByRole("link", { name: new RegExp(`\\b${patient}\\b`) });
}

/**
 * Every visible interactive element smaller than 44 px either way (as U5's
 * accessibility walk measures it).
 *
 * @param page - The page.
 * @returns The targets too small.
 */
async function smallTargets(page: Page) {
  return page.evaluate((min) => {
    const selector =
      "a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex='-1'])";
    const small: { element: string; width: number; height: number }[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(element);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        element.getClientRects().length === 0
      ) {
        continue;
      }
      const box = element.getBoundingClientRect();
      if (box.width < min - 0.5 || box.height < min - 0.5) {
        small.push({
          element: `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}"`,
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
      }
    }
    return small;
  }, TARGET_PX);
}

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`the practice's day at ${WIDTHS[width].width} px`, () => {
    test.use({ width });

    test("the plain view shows every booking of the seeded day, each coloured by its case's money", async ({
      page,
    }) => {
      await signInAsPractice(page);
      const days = [...new Set([londonDay(-180), londonDay(0), londonDay(180)])];
      const seen = new Map<string, string | null>();
      for (const day of days) {
        await page.goto(`/day?day=${day}`);
        const links = page.getByRole("region", { name: "Bookings by room" }).getByRole("link");
        for (const link of await links.all()) {
          const name = (await link.textContent()) ?? "";
          const patient = SEEDED_PATIENTS.find((one) => name.includes(one));
          if (patient) {
            seen.set(patient, await link.getAttribute("data-tone"));
          }
        }
      }

      expect([...seen.keys()].sort()).toEqual(SEEDED_PATIENTS);
      expect(seen.get("Juno")).toBe("update_awaiting_owner");
      expect(seen.get("Biscuit")).toBe("held");
      expect(seen.get("Archie")).toBe("awaiting_owner");
      expect(seen.get("Pip")).toBe("estimate_draft");
      expect(seen.get("Bramble")).toBe("update_declined");
      await expect(
        page.getByRole("navigation", { name: "Practice" }).getByRole("link", { name: "The day" }),
      ).toHaveAttribute("aria-current", "page");
    });

    test("the agent holds the slot at once; Move it, the practice's click, moves the next procedure into it", async ({
      page,
    }) => {
      const slot = await openHeldDay(page);
      const held = page.getByRole("region", { name: "Held by pawhold" });
      await expect(held).toContainText("Held by pawhold at");
      await expect(held).toContainText("Ellis hasn't approved the update for Juno.");
      await expect(held).toContainText(
        `Move Biscuit's procedure to ${slot}, after Juno's update is answered?`,
      );
      await expect(bookingOf(page, "Juno")).toContainText("Held by pawhold");
      await expect(bookingOf(page, "Juno")).toContainText(`${slot} to`);
      await expect(bookingOf(page, "Biscuit")).toContainText(`Move to ${slot} proposed`);
      await expect(bookingOf(page, "Biscuit")).not.toContainText(`${slot} to`);
      if (shots) {
        await page.screenshot({
          path: join(shots, `day-held-${WIDTHS[width].width}.png`),
          fullPage: true,
        });
      }

      await held.getByRole("button", { name: "Move it" }).click();

      await expect(bookingOf(page, "Biscuit")).toContainText(`${slot} to`);
      await expect(bookingOf(page, "Biscuit")).not.toContainText("proposed");
      await expect(bookingOf(page, "Juno")).not.toContainText(`${slot} to`);
      await expect(bookingOf(page, "Juno")).toContainText("Held by pawhold");
      await expect(held.getByRole("button", { name: "Move it" })).toHaveCount(0);
      await expect(held.getByRole("button", { name: "Undo" })).toBeVisible();
      if (shots) {
        await page.screenshot({
          path: join(shots, `day-moved-${WIDTHS[width].width}.png`),
          fullPage: true,
        });
      }
    });

    test("Undo releases the hold with one click, and its move with it", async ({ page }) => {
      await openHeldDay(page);
      const held = page.getByRole("region", { name: "Held by pawhold" });

      await held.getByRole("button", { name: "Undo" }).click();

      await expect(held).toHaveCount(0);
      await expect(bookingOf(page, "Juno")).not.toContainText("Held by pawhold");
      await expect(bookingOf(page, "Biscuit")).not.toContainText("proposed");
      await page.reload();
      await expect(page.getByText(/pawhold checked the day at/)).toBeVisible();
      await expect(page.getByRole("region", { name: "Held by pawhold" })).toHaveCount(0);
    });

    test("Dismiss keeps the hold and drops the move", async ({ page }) => {
      await openHeldDay(page);
      const held = page.getByRole("region", { name: "Held by pawhold" });

      await held.getByRole("button", { name: "Dismiss" }).click();

      await expect(held.getByRole("button", { name: "Move it" })).toHaveCount(0);
      await expect(held.getByRole("button", { name: "Undo" })).toBeVisible();
      await expect(bookingOf(page, "Juno")).toContainText("Held by pawhold");
      await expect(bookingOf(page, "Biscuit")).not.toContainText("proposed");
    });

    test("axe finds no serious violation and every target is at least 44 px: the day with a hold", async ({
      page,
    }) => {
      await openHeldDay(page);

      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations
        .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
        .map((violation) => ({
          id: violation.id,
          targets: violation.nodes.map((node) => node.target.join(" ")),
        }));
      expect(serious).toEqual([]);
      expect(await smallTargets(page)).toEqual([]);
    });
  });
}
