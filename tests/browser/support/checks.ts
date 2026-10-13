import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/*
 * The checks every screen passes at 390 and 1440 px (the plan's acceptance
 * for U5, U6, U9 and U11; WCAG 2.5.5's size): no serious or critical axe
 * violation, and every target at least 44 px each way. One copy for the
 * practice's walks, the owner's and the day's (U11 folded U5's, U6's and
 * U8a's three).
 */

/** The smallest a tap target may be, each way. */
export const TARGET_PX = 44;

/** What can be tapped, PayPal's own button included. */
const TARGETS = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
  "[role=button]",
  "[role=link]",
  "paypal-button",
].join(",");

/** A target found smaller than {@link TARGET_PX}. */
export interface SmallTarget {
  readonly element: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Every visible target smaller than 44 px either way. A checkbox or radio
 * inside its label is measured by the label, which is its target; anything
 * inside a closed disclosure or dialog is not on the screen.
 *
 * @param page - The page.
 * @returns The targets too small.
 */
export async function smallTargets(page: Page): Promise<SmallTarget[]> {
  return page.evaluate(
    ({ selector, min }) => {
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
        const target =
          element instanceof HTMLInputElement &&
          (element.type === "checkbox" || element.type === "radio") &&
          element.closest("label")
            ? element.closest("label")!
            : element;
        const box = target.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) {
          continue;
        }
        if (box.width < min - 0.5 || box.height < min - 0.5) {
          small.push({
            element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""} "${(element.textContent ?? element.getAttribute("aria-label") ?? "").trim().slice(0, 40)}"`,
            width: Math.round(box.width),
            height: Math.round(box.height),
          });
        }
      }
      return small;
    },
    { selector: TARGETS, min: TARGET_PX },
  );
}

/**
 * Runs axe over the page and fails on any serious or critical violation.
 *
 * @param page - The page.
 * @param exclude - Selectors axe leaves out (PayPal's own frames, which pawhold does not draw).
 */
export async function expectNoSeriousViolations(
  page: Page,
  exclude: readonly string[] = [],
): Promise<void> {
  let builder = new AxeBuilder({ page });
  for (const selector of exclude) {
    builder = builder.exclude(selector);
  }
  const results = await builder.analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
  expect(serious).toEqual([]);
}

/**
 * Fails on any visible target smaller than 44 px each way.
 *
 * @param page - The page.
 */
export async function expectTargetsAtLeast44(page: Page): Promise<void> {
  expect(await smallTargets(page)).toEqual([]);
}

/**
 * Checks the page as it stands: no serious or critical axe violation, and
 * every target at least 44 px.
 *
 * @param page - The page.
 * @param exclude - Selectors axe leaves out.
 */
export async function checkScreen(page: Page, exclude: readonly string[] = []): Promise<void> {
  await expectNoSeriousViolations(page, exclude);
  await expectTargetsAtLeast44(page);
}

/**
 * Waits until PayPal's SDK has drawn its button and card fields, or the
 * page has said authorising is unavailable, so a shot or a check sees the
 * page as the owner does once it has loaded.
 *
 * @param page - The page.
 */
export async function untilPayPalDrawn(page: Page): Promise<void> {
  const button = page.locator("paypal-button");
  // Not `getByRole("alert")`: Next's route announcer is one too.
  const unavailable = page.getByText(/^Authorising isn't available on this page right now\./);
  await expect(button.or(unavailable)).toBeVisible({ timeout: 30_000 });
  if (await button.isVisible()) {
    for (const type of ["name", "number", "expiry", "cvv"]) {
      await expect(
        page.frameLocator(`[data-card-field=${type}] iframe`).locator("input").first(),
      ).toBeVisible({ timeout: 30_000 });
    }
  }
}
