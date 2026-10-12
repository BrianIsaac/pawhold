import { expect, type Locator, type Page, test } from "@playwright/test";

import { approveInWindow } from "../../probes/buyer";
import { DRAFT_FAILED } from "../../src/agent/wording";
import { WIDTHS } from "../browser/fixtures";
import { type ReadmeWalk, walkReadme } from "../browser/support/readme-walk";

import { smokeBuyer } from "./support/target";

/*
 * The live smoke (U10's acceptance), against the deployment: the README's
 * testing instructions walked as a judge would, in one fresh browser, so in
 * one judge session. "Two minutes as the owner" opens the landing page and
 * the owner door and authorises Otis's hold through PayPal's own sandbox
 * window with the GB buyer (U0's buyer automation); "As the practice"
 * discharges that session's Otis, which captures at PayPal and releases the
 * rest, and drafts an estimate with the live model. The model's lines are
 * never asserted, only that a draft arrived or the empty estimate said why.
 * Then the case's timeline must show PayPal's webhook confirming the hold
 * and the capture, and the walk writes PayPal's ids to the log. Nothing is
 * voided by hand: the discharge leaves nothing held, and the session's
 * clean-up prunes it after seven days.
 */

/** The README's promise: a stranger reaches a held case in under two minutes. */
const TWO_MINUTES_MS = 2 * 60 * 1000;

/** How long a live draft may take: the model's own 120 s limit, and the page. */
const DRAFT_MS = 150_000;

/** How long PayPal's webhooks may take to reach the deployment (P8: p95 34 s). */
const WEBHOOK_MS = 5 * 60 * 1000;

/** What the owner's sandbox panel says when the server has no buyer login (U9). */
const LOGIN_IN_README = "In the Testing instructions of pawhold's README.";

const buyer = smokeBuyer();
const secrets = [buyer.email, buyer.password];

/**
 * PayPal's step: the GB sandbox buyer approves in PayPal's own window,
 * after the sandbox panel's login line is recorded (the server shows the
 * login once Render's service has it, else the README's pointer).
 *
 * @param page - The owner's page.
 */
async function approveAsBuyer(page: Page): Promise<void> {
  const login = await page
    .locator("dt", { hasText: "PayPal login" })
    .locator("xpath=following-sibling::dd[1]")
    .first()
    .textContent();
  record(
    "owner's sandbox panel",
    login?.includes(buyer.email)
      ? "shows the sandbox buyer's login"
      : login?.trim() === LOGIN_IN_README
        ? "points to the README for the login"
        : "shows no login",
  );
  const button = page.locator("paypal-button");
  await expect(button).toBeVisible({ timeout: 30_000 });
  const opened = page.waitForEvent("popup");
  await button.click();
  const approval = await approveInWindow(await opened, buyer, secrets);
  test.info().annotations.push({
    type: "PayPal approval",
    description: `${approval.seconds} s, funding ${String(approval.funding)}`,
  });
}

/**
 * What a step's words must find on the live deployment: a draft from the
 * live model shows "From your notes" under each line, and a draft that did
 * not work shows the empty estimate's sentence instead.
 *
 * @param page - The page.
 * @param text - The step's words.
 * @returns The element showing them.
 */
function seenLive(page: Page, text: string): Locator {
  const seen = page.getByText(text).first();
  return text === "From your notes" ? seen.or(page.getByText(DRAFT_FAILED)).first() : seen;
}

const LIVE: ReadmeWalk = { approve: approveAsBuyer, seen: seenLive, seeTimeoutMs: DRAFT_MS };

/**
 * The value beside a term of a timeline row's "Show PayPal and model details".
 *
 * @param row - The row, its details open.
 * @param term - The term.
 * @returns The value.
 */
async function detail(row: Locator, term: string): Promise<string> {
  const value = row.locator("dt", { hasText: term }).locator("xpath=following-sibling::dd[1]");
  return (await value.first().textContent())?.trim() ?? "";
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

    const started = Date.now();
    await walkReadme(page, "Two minutes as the owner", LIVE);
    const took = Date.now() - started;
    record("owner door to held", `${took} ms`);
    expect(took).toBeLessThan(TWO_MINUTES_MS);

    await test.step("the session is the judge's own", async () => {
      const session = await page.request.get("/api/judge/session");
      expect(session.status()).toBe(200);
      const { practiceId } = (await session.json()) as { practiceId: string };
      record("judge practice", practiceId);
    });

    await walkReadme(page, "As the practice", LIVE);
    const drafted = await page
      .getByText("From your notes")
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
      record("captured", (await captured.locator("p").first().textContent())?.trim() ?? "");
    });
  } finally {
    await browser.close();
  }
});
