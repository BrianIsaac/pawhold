import { type Browser, chromium, type Page } from "playwright";

import { RETURN_URL } from "./paypal";

/*
 * The sandbox buyer: a headless Chromium signs in to www.sandbox.paypal.com
 * with the GB personal account and approves an order, as an owner would on
 * their phone. One browser per approval, closed the moment it is done; P9
 * keeps one open across its steps to read the buyer's activity, and closes
 * it at the end of them.
 */

const SANDBOX_HOME = "https://www.sandbox.paypal.com";
const STEP_TIMEOUT_MS = 60_000;

/** One approval, as the report keeps it. */
export interface Approval {
  /** When the browser opened the approval link. */
  readonly startedAt: string;
  /** Seconds from opening the link to the return URL. */
  readonly seconds: number;
  /** Whether the buyer had to sign in (false when the session was already signed in). */
  readonly signedIn: boolean;
  /** The funding option selected on the review page (`BALANCEGBP`, `CC`, ...). */
  readonly funding: string | null;
  /** The review page's line on the amount the buyer agrees to, as shown. */
  readonly notice: string | null;
}

/** What the buyer's own account showed at one moment. */
export interface ActivityReading {
  readonly at: string;
  /** The page read, without its query. */
  readonly page: string;
  /** The activity entries' text, one per entry, as shown. */
  readonly entries: readonly string[];
}

/** A browser session held across steps (P9). */
export interface BuyerSession {
  approve(url: string): Promise<Approval>;
  /** Reads the buyer's recent activity in the signed-in session. */
  activity(): Promise<ActivityReading>;
}

/** The buyer, to the probes. */
export interface Buyer {
  /** Approves an order in a browser of its own, closed when done. */
  approve(url: string): Promise<Approval>;
  /** Runs steps in one browser session, closed when they end. */
  session<T>(steps: (session: BuyerSession) => Promise<T>): Promise<T>;
}

/** The sandbox buyer's login. */
export interface BuyerLogin {
  readonly email: string;
  readonly password: string;
}

/**
 * The buyer in a headless Chromium.
 *
 * @param login - The sandbox personal account's login; never logged.
 * @param secrets - Values scrubbed from any error text.
 * @returns The buyer.
 */
export function createBrowserBuyer(login: BuyerLogin, secrets: readonly string[]): Buyer {
  const session = async <T>(steps: (s: BuyerSession) => Promise<T>): Promise<T> => {
    const browser: Browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ locale: "en-GB", timezoneId: "Europe/London" });
      const page = await context.newPage();
      page.setDefaultTimeout(STEP_TIMEOUT_MS);
      await page.route(`${new URL(RETURN_URL).origin}/**`, (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: "returned" }),
      );
      return await steps({
        approve: (url) => approveIn(page, url, login, secrets),
        activity: () => readActivity(page, secrets),
      });
    } finally {
      await browser.close();
    }
  };
  return {
    approve: (url) => session((s) => s.approve(url)),
    session,
  };
}

/**
 * Approves an order on PayPal's sandbox checkout, signing in when asked.
 *
 * @param page - The page.
 * @param url - The order's approval link.
 * @param login - The buyer's login.
 * @param secrets - Values scrubbed from error text.
 * @returns The approval.
 */
async function approveIn(
  page: Page,
  url: string,
  login: BuyerLogin,
  secrets: readonly string[],
): Promise<Approval> {
  const started = Date.now();
  try {
    await page.goto(url);
    const email = page.locator("#email");
    const review = page.getByTestId("submit-button-initial");
    await email.or(review).first().waitFor({ state: "visible" });
    const signedIn = await email.isVisible();
    if (signedIn) {
      await email.fill(login.email);
      const next = page.locator("#btnNext");
      if (await next.isVisible()) {
        await next.click();
      }
      const password = page.locator("#password");
      await password.waitFor({ state: "visible" });
      await password.fill(login.password);
      await page.locator("#btnLogin").click();
    }
    await review.waitFor({ state: "visible" });
    const fundingId = await page
      .locator('input[name="FIRadioGroup"]:checked')
      .first()
      .getAttribute("id")
      .catch(() => null);
    const notice = await page
      .getByText(/agree to pay up to/i)
      .first()
      .textContent()
      .catch(() => null);
    await review.click();
    await page.waitForURL((u) => u.href.startsWith(RETURN_URL));
    return {
      startedAt: new Date(started).toISOString(),
      seconds: Math.round((Date.now() - started) / 100) / 10,
      signedIn,
      funding: fundingOption(fundingId),
      notice: notice?.replace(/\s+/g, " ").trim() ?? null,
    };
  } catch (error) {
    throw new Error(`buyer approval failed at ${await describe(page, secrets)}`, { cause: error });
  }
}

/**
 * Reads the signed-in buyer's recent activity on the sandbox account.
 *
 * @param page - A signed-in page.
 * @param secrets - Values scrubbed from what is read.
 * @returns The reading.
 */
async function readActivity(page: Page, secrets: readonly string[]): Promise<ActivityReading> {
  await page.goto(`${SANDBOX_HOME}/myaccount/activities/`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const entries = await page
    .locator('[data-testid*="activity"] li, li[data-testid], ol li')
    .allInnerTexts();
  const url = new URL(page.url());
  return {
    at: new Date().toISOString(),
    page: `${url.origin}${url.pathname}`,
    entries: entries
      .map((e) => scrub(e.replace(/\s+/g, " ").trim(), secrets))
      .filter((e) => e.length > 0),
  };
}

/**
 * The funding option's kind, without the instrument's id.
 *
 * @param id - The checked radio's id, such as `BALANCEGBP-funding-option`.
 * @returns The kind, such as `BALANCEGBP` or `CC`, or null.
 */
function fundingOption(id: string | null): string | null {
  if (!id) {
    return null;
  }
  const kind = id.replace(/-funding-option$/, "");
  return kind.startsWith("CC-") ? "CC" : kind;
}

/**
 * Where the page stands, for an error: its path and its visible buttons.
 *
 * @param page - The page.
 * @param secrets - Values scrubbed from the text.
 * @returns The description.
 */
async function describe(page: Page, secrets: readonly string[]): Promise<string> {
  const url = new URL(page.url());
  const buttons = await page
    .locator("button:visible")
    .allInnerTexts()
    .catch(() => [] as string[]);
  return scrub(
    `${url.origin}${url.pathname} (buttons: ${buttons.map((b) => b.trim()).join(" | ")})`,
    secrets,
  );
}

/**
 * Replaces every secret in a text.
 *
 * @param text - The text.
 * @param secrets - The values to remove.
 * @returns The text without them.
 */
function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, s) => (s.length > 0 ? out.replaceAll(s, "<redacted>") : out), text);
}
