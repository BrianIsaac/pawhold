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

/** Plan 3.4's own notes: eval set 01, whose recorded answer the walks' double gives. */
export const PLAN_NOTES =
  "GA, dental scale and polish, probable two extractions upper PM, pre-op bloods";

/**
 * Opens a case from today's "New case" and lands on it.
 *
 * @param page - The page, signed in as the practice.
 * @param kase - The patient, its species, the owner and the procedure.
 * @param kase.patient - The patient.
 * @param kase.species - The species' label as the field offers it; "Dog" when not given.
 * @param kase.owner - The owner.
 * @param kase.procedure - The procedure.
 * @returns Resolves on the case's page.
 */
export async function openNewCase(
  page: Page,
  kase: { patient: string; owner: string; procedure: string; species?: string },
): Promise<void> {
  await page.goto("/today");
  await page.getByRole("button", { name: "New case" }).click();
  const dialog = page.getByRole("dialog", { name: "Open a case" });
  await dialog.getByLabel("Patient").fill(kase.patient);
  await dialog.getByLabel("Species").selectOption({ label: kase.species ?? "Dog" });
  await dialog.getByLabel("Owner").fill(kase.owner);
  await dialog.getByLabel("Procedure").fill(kase.procedure);
  await dialog.getByRole("button", { name: "Open the case" }).click();
  await expect(page.getByRole("heading", { level: 1, name: kase.patient })).toBeVisible();
}
