import { expect, test } from "@playwright/test";

import { approveInWindow } from "../../../probes/buyer";

import { openBrowserDatabase, sentBrambleEstimate } from "./support/cases";
import { expectNoSeriousViolations, expectTargetsAtLeast44 } from "./support/checks";
import {
  buyerLogin,
  sandboxConfigured,
  sandboxSecrets,
  TEST_CARD,
  voidWhatTheWalksHeld,
  webhookReachable,
} from "./support/sandbox";
import { saveShot } from "./support/shots";

const database = openBrowserDatabase();
const practices: string[] = [];

test.afterAll(async () => {
  await database.close();
});

/** What PayPal's SDK draws on the page: its card fields' frames and its window's overlay. */
const PAYPAL_DRAWN = ["iframe", "paypal-sdk-paypal-modal"];

/** The webhook's tick: PayPal's own event, reconciled; P8 and P9 saw lags of about 20 s. */
const TICK = /^Confirmed by PayPal \d{2}:\d{2}:\d{2}$/;

test.describe("the owner authorises through PayPal's sandbox", () => {
  test.skip(!sandboxConfigured, "PAYPAL_CLIENT_ID is not set: the sandbox walks are skipped");
  test.describe.configure({ timeout: 240_000 });

  test.afterAll(async () => {
    const stillHeld = await voidWhatTheWalksHeld(database.db, practices);
    expect(stillHeld, "the walks must leave nothing held").toEqual([]);
  });

  test("the GB buyer approves through PayPal's sandbox and the case is held, confirmed by the webhook's tick", async ({
    page,
  }) => {
    const sent = await sentBrambleEstimate(database.db);
    practices.push(sent.practiceId);
    await page.goto(sent.path);

    const button = page.locator("paypal-button");
    await expect(button).toBeVisible({ timeout: 30_000 });
    await expectNoSeriousViolations(page, PAYPAL_DRAWN);
    await expectTargetsAtLeast44(page);
    await saveShot(page, "estimate-with-paypal");

    const opened = page.waitForEvent("popup");
    await button.click();
    const window = await opened;
    const approval = await approveInWindow(window, buyerLogin(), sandboxSecrets(), (review) =>
      saveShot(review, "paypal-approval"),
    );
    console.info(
      `PayPal's approval: ${approval.seconds} s; funding ${approval.funding}; "${approval.notice}"`,
    );

    await expect(page.getByText("Held", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByText(
        "Done. £927.00 is held on your PayPal. You'll get the final bill at discharge.",
      ),
    ).toBeVisible();
    // PayPal's overlay covers the page while its window is open; it must go with the window.
    await expect(page.locator("paypal-sdk-paypal-modal")).toBeHidden({ timeout: 15_000 });
    await expectNoSeriousViolations(page, PAYPAL_DRAWN);
    await expectTargetsAtLeast44(page);
    if (webhookReachable) {
      await expect(page.getByText(TICK)).toBeVisible({ timeout: 90_000 });
    } else {
      test.info().annotations.push({
        type: "tick",
        description: "not waited for: no webhook reaches this run's server",
      });
    }
    await saveShot(page, "held-paypal");
  });

  test("a test card authorises through card fields", async ({ page }) => {
    const sent = await sentBrambleEstimate(database.db);
    practices.push(sent.practiceId);
    await page.goto(sent.path);

    const fields: [keyof typeof TEST_CARD, string][] = [
      ["name", TEST_CARD.name],
      ["number", TEST_CARD.number],
      ["expiry", TEST_CARD.expiry],
      ["cvv", TEST_CARD.cvv],
    ];
    for (const [type, value] of fields) {
      const input = page.frameLocator(`[data-card-field=${type}] iframe`).locator("input").first();
      await input.waitFor({ state: "visible", timeout: 30_000 });
      await input.click();
      await input.pressSequentially(value, { delay: 20 });
    }
    await page.getByRole("button", { name: "Authorise £927.00" }).click();

    await expect(page.getByText("Held", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(
      page.getByText("Done. £927.00 is held on your card. You'll get the final bill at discharge."),
    ).toBeVisible();
    if (webhookReachable) {
      await expect(page.getByText(TICK)).toBeVisible({ timeout: 90_000 });
    }
    await saveShot(page, "held-card");
  });
});
