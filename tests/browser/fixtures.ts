import { test as base, expect, type Page } from "@playwright/test";

/** The two widths every screen is checked at (plan 5, U5's acceptance). */
export const WIDTHS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;

export type Width = keyof typeof WIDTHS;

/**
 * Playwright's `test` with a browser of each test's own: launched headless
 * for the test and closed at its end, whatever the outcome, so no browser
 * outlives the test that opened it.
 */
export const test = base.extend<{ width: Width }>({
  width: ["desktop", { option: true }],
  page: async ({ playwright, baseURL, width }, provide) => {
    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        ...(baseURL ? { baseURL } : {}),
        viewport: WIDTHS[width],
        locale: "en-GB",
        timezoneId: "Europe/London",
      });
      await provide(await context.newPage());
    } finally {
      await browser.close();
    }
  },
});

export { expect };

/**
 * Signs the page in as the practice through U1's judge session: the
 * practice's door, a new seeded practice, and its cookie on the page's
 * context.
 *
 * @param page - The page.
 * @returns The new practice's id.
 */
export async function signInAsPractice(page: Page): Promise<string> {
  const response = await page.request.post("/api/judge/session", { data: { door: "practice" } });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { practiceId: string };
  return body.practiceId;
}
