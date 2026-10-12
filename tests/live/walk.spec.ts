import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";

import { approveInWindow, type BuyerLogin } from "../../probes/buyer";
import { DRAFT_FAILED } from "../../src/agent/wording";
import { WIDTHS } from "../browser/fixtures";
import { type ReadmeWalk, walkReadme } from "../browser/support/readme-walk";

import { sandboxPanelLogin } from "./support/panel";
import { smokeBuyer } from "./support/target";

/*
 * The live smoke (U10's acceptance), against the deployment: the README's
 * testing instructions walked as a judge would, in one fresh browser, so in
 * one judge session. "Two minutes as the owner" opens the landing page and
 * the owner door and authorises Otis's hold through PayPal's own sandbox
 * window with the GB buyer (U0's buyer automation); "As the practice"
 * discharges that session's Otis, which captures at PayPal and releases the
 * rest, and drafts an estimate with the live model. The model's lines are
 * never asserted, only that a draft arrived or the empty estimate said why
 * (the log says which).
 * Then the case's timeline must show PayPal's webhook confirming the hold
 * and the capture, and the walk writes PayPal's ids to the log. Nothing is
 * voided by hand: the discharge leaves nothing held, and a walk that fails
 * part way leaves its practice's id in the log and its hold to the
 * session's clean-up, which voids it after seven days. The README's two
 * minutes are checked last, so a slow sandbox never stops a walk before
 * its discharge.
 */

/** The README's promise: a stranger reaches a held case in under two minutes. */
const TWO_MINUTES_MS = 2 * 60 * 1000;

/** How long a live draft may take: the model's own 120 s limit, and the page. */
const DRAFT_MS = 150_000;

/** The words under each drafted line (U4), which the README's draft step names. */
const DRAFTED = "From your notes";

/** How long PayPal's webhooks may take to reach the deployment (P8: p95 34 s). */
const WEBHOOK_MS = 5 * 60 * 1000;

/** How long a read of a term the page has already drawn may take. */
const READ_MS = 5_000;

/** `GET /api/judge/session`'s answer, as far as the walk reads it. */
const judgeSession = z.object({ practiceId: z.uuid() });

/**
 * How the live smoke walks the README: PayPal's step by the GB sandbox
 * buyer in PayPal's own window (after the sandbox panel is recorded), and a
 * draft from the live model, which shows "From your notes" under each line
 * or, when it did not work, the empty estimate's sentence; only the draft
 * waits as long as the model may take.
 *
 * @param buyer - The README's buyer.
 * @returns The walk.
 */
function liveWalk(buyer: BuyerLogin): ReadmeWalk {
  const secrets = [buyer.email, buyer.password];
  return {
    approve: async (page) => {
      record("owner's sandbox panel", `shows ${await sandboxPanelLogin(page, buyer)}`);
      const button = page.locator("paypal-button");
      await expect(button).toBeVisible({ timeout: 30_000 });
      const opened = page.waitForEvent("popup");
      await button.click();
      const approval = await approveInWindow(await opened, buyer, secrets);
      record("PayPal approval", `${approval.seconds} s, funding ${String(approval.funding)}`);
    },
    seen: (page, text) => {
      const seen = page.getByText(text).first();
      return text === DRAFTED ? seen.or(page.getByText(DRAFT_FAILED)).first() : seen;
    },
    seeTimeoutMs: (text) => (text === DRAFTED ? DRAFT_MS : 20_000),
  };
}

/**
 * Records the walk's judge practice, so a walk that fails part way can be
 * found; it never throws over the walk's own failure.
 *
 * @param page - The page, in the walk's session.
 */
async function recordSession(page: Page): Promise<void> {
  const answer = await page.request.get("/api/judge/session").catch(() => null);
  const session = answer?.ok() ? judgeSession.safeParse(await answer.json()) : null;
  record("judge practice", session?.success ? session.data.practiceId : "no session");
}

/**
 * The value beside a term of a timeline row's "Show PayPal and model details".
 *
 * @param row - The row, its details open.
 * @param term - The term.
 * @returns The value.
 */
async function detail(row: Locator, term: string): Promise<string> {
  const value = row.locator("dt", { hasText: term }).locator("xpath=following-sibling::dd[1]");
  return (await value.first().textContent({ timeout: READ_MS }))?.trim() ?? "";
}

/**
 * Records a fact of the walk in the job's log and the report.
 *
 * @param type - What it is.
 * @param description - Its value; never a secret.
 */
function record(type: string, description: string): void {
  test.info().annotations.push({ type, description });
  console.info(`pawhold live: ${type}: ${description}`);
}

test("a judge's walk on the deployment: the owner door's hold with PayPal, the discharge, a live draft", async ({
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
    const walk = liveWalk(smokeBuyer());

    const started = Date.now();
    try {
      await walkReadme(page, "Two minutes as the owner", walk);
    } finally {
      await recordSession(page);
    }
    const took = Date.now() - started;
    record("owner door to held", `${took} ms`);

    await walkReadme(page, "As the practice", walk);
    const drafted = await page
      .getByText(DRAFTED)
      .first()
      .isVisible()
      .catch(() => false);
    record("draft", drafted ? "the live model drafted lines" : "the empty estimate");

    await test.step("PayPal's webhooks confirm the hold and the capture on Otis's timeline", async () => {
      await page.goto("/today");
      await page.getByRole("link", { name: "Otis", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Otis" })).toBeVisible();
      const timeline = page.getByRole("region", { name: "Timeline" });
      const authorised = timeline.getByRole("listitem").filter({ hasText: /authorised a hold of/ });
      const captured = timeline.getByRole("listitem").filter({ hasText: /captured £/ });
      const confirmed = /confirmed \d{2}:\d{2}:\d{2}/;
      await expect(async () => {
        await page.reload();
        const rows = await timeline.locator("li > p").allTextContents();
        const seen = `Otis's timeline at ${new URL(page.url()).pathname}: ${rows.join(" | ")}`;
        expect(
          rows.some((row) => /authorised a hold of/.test(row) && confirmed.test(row)),
          seen,
        ).toBe(true);
        expect(
          rows.some((row) => /captured £/.test(row) && confirmed.test(row)),
          seen,
        ).toBe(true);
      }).toPass({ timeout: WEBHOOK_MS, intervals: [5_000] });

      await authorised.getByText("Show PayPal and model details").click();
      await captured.getByText("Show PayPal and model details").click();
      record("PayPal order", await detail(authorised, "PayPal order"));
      record("PayPal authorisation", await detail(authorised, "PayPal authorisation"));
      record("PayPal capture", await detail(captured, "PayPal capture"));
      record(
        "captured",
        (await captured.locator("p").first().textContent({ timeout: READ_MS }))?.trim() ?? "",
      );
    });

    // Checked last, once the discharge has left nothing held.
    expect(took, "the README's two minutes, owner door to held").toBeLessThan(TWO_MINUTES_MS);
  } finally {
    await browser.close();
  }
});
