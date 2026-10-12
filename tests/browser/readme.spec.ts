import type { Page } from "@playwright/test";

import { approveInWindow } from "../../probes/buyer";

import { expect, test, WIDTHS } from "./fixtures";
import { openBrowserDatabase } from "./owner/support/cases";
import {
  buyerLogin,
  sandboxConfigured,
  sandboxSecrets,
  voidWhatTheWalksHeld,
} from "./owner/support/sandbox";
import { DOUBLE_URL } from "./support/discharge";
import { type ReadmeWalk, walkReadme } from "./support/readme-walk";

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

/** The acceptance's bound: a stranger reaches a held case in under two minutes. */
const TWO_MINUTES_MS = 2 * 60 * 1000;

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

/** How the browser suite walks the README: PayPal's step as {@link approveWithPayPal} has it. */
const WALK: ReadmeWalk = { approve: approveWithPayPal };

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
      try {
        await walkReadme(page, "Two minutes as the owner", WALK);
      } finally {
        // Registered whatever became of the walk, so whatever it held is voided.
        const session = await page.request.get("/api/judge/session");
        if (session.ok()) {
          practices.push(((await session.json()) as { practiceId: string }).practiceId);
        }
      }
      const took = Date.now() - started;
      test.info().annotations.push({ type: "owner door to held", description: `${took} ms` });
      expect(took).toBeLessThan(TWO_MINUTES_MS);

      if (sandboxConfigured) {
        test.info().annotations.push({
          type: "practice",
          description: "not walked against the sandbox: its discharge would capture there",
        });
        return;
      }
      await walkReadme(page, "As the practice", WALK);
    } finally {
      await browser.close();
    }
  });
});
