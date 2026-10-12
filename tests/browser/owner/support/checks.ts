import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/*
 * The checks every owner's page passes at 390 px: no serious or critical axe
 * violation, and every target at least 44 px each way (the plan's acceptance
 * and WCAG 2.5.5's size). Next's development overlay (`nextjs-portal`, drawn
 * by `next dev` only) is not the page and is left out of both.
 */

const DEV_OVERLAY = "nextjs-portal";

const MIN_TARGET_PX = 44;

/** What can be tapped on the owner's pages, PayPal's own button included. */
const TARGETS = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[tabindex]:not([tabindex='-1'])",
  "paypal-button",
].join(", ");

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
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  for (const selector of [DEV_OVERLAY, ...exclude]) {
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
  const targets = page.locator(TARGETS);
  const small: string[] = [];
  for (const target of await targets.all()) {
    const inOverlay = await target.evaluate(
      (element, overlay) =>
        (element.getRootNode() as ShadowRoot).host?.tagName.toLowerCase() === overlay,
      DEV_OVERLAY,
    );
    if (inOverlay || !(await target.isVisible())) {
      continue;
    }
    const box = await target.boundingBox();
    if (box && (box.width < MIN_TARGET_PX || box.height < MIN_TARGET_PX)) {
      const label = await target.evaluate(
        (element) =>
          `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}"`,
      );
      small.push(`${label}: ${Math.round(box.width)} x ${Math.round(box.height)}`);
    }
  }
  expect(small).toEqual([]);
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
