import type { Locator, Page } from "@playwright/test";

import { approveInWindow } from "../../probes/buyer";

import { expect, PLAN_NOTES, test, WIDTHS } from "./fixtures";
import { openBrowserDatabase } from "./owner/support/cases";
import {
  buyerLogin,
  sandboxConfigured,
  sandboxSecrets,
  voidWhatTheWalksHeld,
} from "./owner/support/sandbox";
import { readmeSteps, type ReadmeStep, type StepAction } from "./support/readme";
import { DOUBLE_URL } from "./support/discharge";

/*
 * The README's testing instructions, walked as written (U9's acceptance): a
 * fresh browser follows "Two minutes as the owner" step by step from the
 * landing page to a held case, timed, then "As the practice" in the same
 * practice. The one live step is PayPal's: with sandbox credentials the
 * sandbox buyer approves in PayPal's own window and the hold is voided at
 * the end; without them the owner's approval is played at the run's PayPal
 * double, as PayPal's SDK would ask the server, and the practice's steps
 * (which capture at the double) are walked too.
 */

/** The deployment's address, which the walk reads as the run's own server. */
const ADDRESS = "https://pawhold.onrender.com";

/** The acceptance's bound: a stranger reaches a held case in under two minutes. */
const TWO_MINUTES_MS = 2 * 60 * 1000;

/** What the new case's form is filled with. */
const NEW_CASE = { Patient: "Pepper", Owner: "Sam Patel", Procedure: "Dental" } as const;

const database = openBrowserDatabase();
const practices: string[] = [];

test.afterAll(async () => {
  if (sandboxConfigured) {
    const stillHeld = await voidWhatTheWalksHeld(database.db, practices);
    expect(stillHeld, "the walk must leave nothing held").toEqual([]);
  }
  await database.close();
});

/**
 * What a step names: the link or button by that name, or else the text, in
 * the open dialog when the step says so or one is open.
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
 * PayPal's step: the sandbox buyer approves in PayPal's window when the run
 * has credentials; otherwise the approval is played at the double and the
 * server asked as PayPal's SDK asks it, then the page read again.
 *
 * @param page - The owner's page.
 */
async function approveWithPayPal(page: Page): Promise<void> {
  if (sandboxConfigured) {
    const button = page.locator("paypal-button");
    await expect(button).toBeVisible({ timeout: 30_000 });
    const opened = page.waitForEvent("popup");
    await button.click();
    await approveInWindow(await opened, buyerLogin(), sandboxSecrets());
    return;
  }
  if (!DOUBLE_URL) {
    throw new Error("the walk needs PayPal's sandbox or the run's PayPal double");
  }
  const path = new URL(page.url()).pathname;
  const ordered = await page.request.post(`${path}/order`);
  expect(ordered.status()).toBe(200);
  const { orderId } = (await ordered.json()) as { orderId: string };
  const approved = await fetch(`${DOUBLE_URL}/__double/orders/${orderId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "paypal" }),
  });
  expect(approved.status).toBe(204);
  const authorised = await page.request.post(`${path}/authorise`, { data: { orderId } });
  expect(authorised.status()).toBe(200);
  await page.reload();
}

/**
 * Does one thing a README step asks.
 *
 * @param page - The page.
 * @param step - The step.
 * @param action - The action.
 */
async function act(page: Page, step: ReadmeStep, action: StepAction): Promise<void> {
  const where = `step ${step.number}: ${step.text}`;
  switch (action.kind) {
    case "open":
      expect(action.url, where).toBe(ADDRESS);
      await page.goto("/");
      return;
    case "click":
      await named(page, action.name, action.inDialog).click();
      return;
    case "type":
      await page.getByRole("textbox", { name: action.field, exact: true }).fill(PLAN_NOTES);
      return;
    case "see":
      await expect(page.getByText(action.text).first(), where).toBeVisible({ timeout: 20_000 });
      return;
    case "new_case": {
      const dialog = page.getByRole("dialog", { name: "Open a case" });
      for (const [label, value] of Object.entries(NEW_CASE)) {
        await dialog.getByLabel(label, { exact: true }).fill(value);
      }
      return;
    }
    case "paypal":
      await approveWithPayPal(page);
      return;
  }
}

/**
 * Walks a README section's steps in order.
 *
 * @param page - The page.
 * @param heading - The section.
 */
async function walk(page: Page, heading: string): Promise<void> {
  for (const step of readmeSteps(heading)) {
    await test.step(`${heading}, step ${step.number}`, async () => {
      for (const action of step.actions) {
        await act(page, step, action);
      }
    });
  }
}

test.describe("the README's testing instructions, walked as written", () => {
  test.describe.configure({ timeout: 300_000 });

  test("a fresh browser reaches a held case through the owner door in under two minutes following the README alone", async ({
    playwright,
    baseURL,
  }) => {
    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        ...(baseURL ? { baseURL } : {}),
        viewport: WIDTHS.desktop,
        locale: "en-GB",
        timezoneId: "Europe/London",
      });
      const page = await context.newPage();

      const started = Date.now();
      await walk(page, "Two minutes as the owner");
      const took = Date.now() - started;
      test.info().annotations.push({ type: "owner door to held", description: `${took} ms` });
      expect(took).toBeLessThan(TWO_MINUTES_MS);

      const session = await page.request.get("/api/judge/session");
      practices.push(((await session.json()) as { practiceId: string }).practiceId);
      if (sandboxConfigured) {
        test.info().annotations.push({
          type: "practice",
          description: "not walked against the sandbox: its discharge would capture there",
        });
        return;
      }
      await walk(page, "As the practice");
    } finally {
      await browser.close();
    }
  });
});
