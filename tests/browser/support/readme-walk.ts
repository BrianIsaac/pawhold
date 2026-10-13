import { expect, type Locator, type Page, test } from "@playwright/test";

import { PLAN_NOTES } from "../fixtures";

import { readmeSteps, type ReadmeStep, type StepAction } from "./readme";

/*
 * Walks a section of the README's testing instructions in a page, step by
 * step, as a stranger reading them would (U9). The browser suite walks them
 * against its own server; the live smoke (U10) against the deployment. What
 * differs between the two is PayPal's step and, for the live model, what a
 * draft may show; the rest is the README's words.
 */

/** The deployment's address, as the README gives it; a walk opens its own base URL for it. */
export const README_ADDRESS = "https://pawhold.onrender.com";

/** What the new case's text fields are filled with. */
export const NEW_CASE = { Patient: "Pepper", Owner: "Sam Patel", Procedure: "Dental" } as const;

/** The species the new case's form is given (U17), by the label its field offers. */
export const NEW_CASE_SPECIES = "Dog";

/** How one walk does what differs between its beds. */
export interface ReadmeWalk {
  /** PayPal's step: the owner approves on the owner's page. */
  readonly approve: (page: Page) => Promise<void>;
  /**
   * What a step's quoted or bold words must find on the page; the first
   * element showing those words by default.
   */
  readonly seen?: (page: Page, text: string) => Locator;
  /** How long a "see" of these words waits; 20 seconds by default. */
  readonly seeTimeoutMs?: (text: string) => number;
}

/**
 * What a step names: the link or button by that name, or else the text, in
 * the open dialog when the step says so.
 *
 * @param page - The page.
 * @param name - The name.
 * @param inDialog - Whether the step names it in the dialog.
 * @returns The first such element.
 */
function named(page: Page, name: string, inDialog: boolean): Locator {
  const scope = inDialog ? page.getByRole("dialog") : page;
  return scope
    .getByRole("link", { name, exact: true })
    .or(scope.getByRole("button", { name, exact: true }))
    .or(scope.getByText(name, { exact: true }))
    .first();
}

/**
 * Does one thing a README step asks.
 *
 * @param page - The page.
 * @param step - The step.
 * @param action - The action.
 * @param walk - How this walk approves and sees.
 */
async function act(
  page: Page,
  step: ReadmeStep,
  action: StepAction,
  walk: ReadmeWalk,
): Promise<void> {
  const where = `step ${step.number}: ${step.text}`;
  switch (action.kind) {
    case "open":
      expect(action.url, where).toBe(README_ADDRESS);
      await page.goto("/");
      return;
    case "click":
      await named(page, action.name, action.inDialog).click();
      return;
    case "type":
      await page.getByRole("textbox", { name: action.field, exact: true }).fill(PLAN_NOTES);
      return;
    case "see": {
      const seen = walk.seen?.(page, action.text) ?? page.getByText(action.text).first();
      await expect(seen, where).toBeVisible({
        timeout: walk.seeTimeoutMs?.(action.text) ?? 20_000,
      });
      return;
    }
    case "new_case": {
      const dialog = page.getByRole("dialog", { name: "Open a case" });
      for (const [label, value] of Object.entries(NEW_CASE)) {
        await dialog.getByLabel(label, { exact: true }).fill(value);
      }
      await dialog
        .getByRole("combobox", { name: "Species", exact: true })
        .selectOption({ label: NEW_CASE_SPECIES });
      return;
    }
    case "paypal":
      await walk.approve(page);
      return;
  }
}

/**
 * Walks a README section's numbered steps in order, each a step of the
 * test's report.
 *
 * @param page - The page.
 * @param heading - The section, without its hashes.
 * @param walk - How this walk approves and sees.
 */
export async function walkReadme(page: Page, heading: string, walk: ReadmeWalk): Promise<void> {
  for (const step of readmeSteps(heading)) {
    await test.step(`${heading}, step ${step.number}`, async () => {
      for (const action of step.actions) {
        await act(page, step, action, walk);
      }
    });
  }
}
