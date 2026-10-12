import { type Browser, chromium, type Page } from "playwright";

import { serveCardPage } from "./card-page";
import { RETURN_URL } from "./paypal";
import { scrub } from "./redact";

/*
 * The sandbox buyer: a headless Chromium signs in to www.sandbox.paypal.com
 * with the GB personal account and approves an order, as an owner would on
 * their phone. One browser per approval, closed the moment it is done; P9
 * keeps one open across its steps to read the buyer's activity, and closes
 * it at the end of them. P6 pays by card instead: the browser opens a local
 * page holding JS SDK v6 card fields and submits a sandbox test card.
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

/** A sandbox test card, as PayPal's testing pages list it. */
export interface TestCard {
  readonly number: string;
  /** `MM/YY`. */
  readonly expiry: string;
  readonly cvv: string;
  readonly name: string;
}

/** One card-fields submission, as the report keeps it. */
export interface CardPayment {
  readonly startedAt: string;
  readonly seconds: number;
  /** `isEligible("advanced_cards")` for GBP, or null when it could not be read. */
  readonly eligible: boolean | null;
  /** Why eligibility could not be read, if it could not. */
  readonly eligibilityError: string | null;
  /** The submit's `state` (`succeeded`, `canceled`, `failed`), or null when it never ran. */
  readonly state: string | null;
  /** The submit's `data`, as returned (ids and liability shift; no card data). */
  readonly data: unknown;
  /** What went wrong before a submit, if anything. */
  readonly error: string | null;
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
  /** Pays for an order with a test card through v6 card fields, in a browser of its own. */
  payByCard(orderId: string, card: TestCard): Promise<CardPayment>;
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
 * @param clientId - The app's client id, for the card page's SDK.
 * @param secrets - Values scrubbed from any error text.
 * @returns The buyer.
 */
export function createBrowserBuyer(
  login: BuyerLogin,
  clientId: string,
  secrets: readonly string[],
): Buyer {
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
        activity: () => readActivity(page, login, secrets),
      });
    } finally {
      await browser.close();
    }
  };
  const payByCard = async (orderId: string, card: TestCard): Promise<CardPayment> => {
    const server = await serveCardPage(clientId);
    try {
      const browser: Browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ locale: "en-GB", timezoneId: "Europe/London" });
        page.setDefaultTimeout(STEP_TIMEOUT_MS);
        return await payIn(page, server.url, orderId, card, secrets);
      } finally {
        await browser.close();
      }
    } finally {
      await server.close();
    }
  };
  return {
    approve: (url) => session((s) => s.approve(url)),
    session,
    payByCard,
  };
}

/** What the card page exposes to the probe. */
interface CardPageState {
  ready: boolean;
  eligible: boolean | null;
  eligibilityError: string | null;
  error: string | null;
}

/**
 * Fills the card fields (each in PayPal's own iframe) and submits them for
 * the order.
 *
 * @param page - The page.
 * @param url - The local card page.
 * @param orderId - The order to pay for.
 * @param card - The test card.
 * @param secrets - Values scrubbed from error text.
 * @returns The submission.
 */
async function payIn(
  page: Page,
  url: string,
  orderId: string,
  card: TestCard,
  secrets: readonly string[],
): Promise<CardPayment> {
  const started = Date.now();
  const done = (rest: Omit<CardPayment, "startedAt" | "seconds">): CardPayment => ({
    startedAt: new Date(started).toISOString(),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    ...rest,
  });
  await page.goto(url);
  const probe = () =>
    page.evaluate(() => (window as unknown as { __probe: CardPageState }).__probe);
  await page
    .waitForFunction(
      () => {
        const state = (window as unknown as { __probe?: CardPageState }).__probe;
        return state !== undefined && (state.ready || state.error !== null);
      },
      undefined,
      { timeout: STEP_TIMEOUT_MS },
    )
    .catch(() => undefined);
  const state = await probe();
  if (!state.ready) {
    return done({
      eligible: state.eligible,
      eligibilityError:
        state.eligibilityError === null ? null : scrub(state.eligibilityError, secrets),
      state: null,
      data: null,
      error: scrub(state.error ?? "the card fields did not render in time", secrets),
    });
  }
  const fields: [string, string][] = [
    ["name", card.name],
    ["number", card.number],
    ["expiry", card.expiry],
    ["cvv", card.cvv],
  ];
  for (const [type, value] of fields) {
    const input = page.frameLocator(`#paypal-card-fields-${type} iframe`).locator("input").first();
    await input.click();
    await input.pressSequentially(value, { delay: 20 });
  }
  const submitted = page.evaluate(
    (id) =>
      (
        window as unknown as {
          __probeSubmit: (orderId: string) => Promise<{ state: string; data: unknown }>;
        }
      ).__probeSubmit(id),
    orderId,
  );
  const result = await Promise.race([
    submitted,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`the card fields' submit did not answer in ${STEP_TIMEOUT_MS} ms`)),
        STEP_TIMEOUT_MS,
      ).unref(),
    ),
  ]);
  return done({
    eligible: state.eligible,
    eligibilityError:
      state.eligibilityError === null ? null : scrub(state.eligibilityError, secrets),
    state: result.state,
    data: scrubJson(result.data, secrets),
    error: null,
  });
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
      await signIn(page, login);
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
      notice: notice ? scrub(notice.replace(/\s+/g, " ").trim(), secrets) : null,
    };
  } catch (error) {
    throw new Error(`buyer approval failed at ${await describe(page, secrets)}`, { cause: error });
  }
}

/**
 * Reads the buyer's recent activity on the account's summary page, signing
 * in to the account first when asked (the checkout's sign-in does not carry
 * over to the account pages). Each entry is one activity tile's text, such as
 * "Test Store −£12.34 Today, 12 Oct . Authorisation".
 *
 * @param page - The session's page.
 * @param login - The buyer's login.
 * @param secrets - Values scrubbed from what is read.
 * @returns The reading.
 */
async function readActivity(
  page: Page,
  login: BuyerLogin,
  secrets: readonly string[],
): Promise<ActivityReading> {
  await page.goto(`${SANDBOX_HOME}/myaccount/summary`);
  if (new URL(page.url()).pathname.startsWith("/signin")) {
    await signIn(page, login);
    await page.waitForURL((u) => u.pathname.startsWith("/myaccount"));
  }
  const tiles = page.getByTestId("trans_overview_root_container");
  await tiles.first().waitFor({ state: "visible" });
  const entries = await tiles.allInnerTexts();
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
 * Signs in on PayPal's sign-in form, which asks for the email and the
 * password on one page or on two.
 *
 * @param page - The page showing the form.
 * @param login - The buyer's login.
 */
async function signIn(page: Page, login: BuyerLogin): Promise<void> {
  await page.locator("#email").fill(login.email);
  const next = page.locator("#btnNext");
  if (await next.isVisible()) {
    await next.click();
  }
  const password = page.locator("#password");
  await password.waitFor({ state: "visible" });
  await password.fill(login.password);
  await page.locator("#btnLogin").click();
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
 * Scrubs every string in a JSON value read off a page.
 *
 * @param value - The value.
 * @param secrets - The values to remove.
 * @returns The scrubbed copy.
 */
function scrubJson(value: unknown, secrets: readonly string[]): unknown {
  return value === undefined
    ? null
    : (JSON.parse(
        JSON.stringify(value, (_key, inner: unknown) =>
          typeof inner === "string" ? scrub(inner, secrets) : inner,
        ),
      ) as unknown);
}
