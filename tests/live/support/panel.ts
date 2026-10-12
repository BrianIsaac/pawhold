import { expect, type Locator, type Page } from "@playwright/test";

import type { BuyerLogin } from "../../../probes/buyer";

/*
 * The owner's sandbox panel (U9, `app/(owner)/e/[token]/sandbox.tsx`) as
 * the live smoke reads it: "PayPal email" and "PayPal password" when the
 * server has the sandbox buyer's login, "PayPal login" pointing to the
 * README when it has not.
 */

/** What the panel says when the server has no buyer login (U9). */
export const LOGIN_IN_README = "In the Testing instructions of pawhold's README.";

/** How long a read of a term the page has already drawn may take. */
const READ_MS = 5_000;

/** What the panel gives for PayPal's login. */
export type SandboxPanelLogin = "the buyer's login" | "the README's pointer";

/**
 * Reads what the owner's sandbox panel gives for PayPal's login. A login
 * other than the README's buyer fails, without the failure saying either.
 *
 * @param page - The owner's page, its sandbox panel drawn.
 * @param buyer - The README's buyer.
 * @returns Which the panel shows.
 */
export async function sandboxPanelLogin(page: Page, buyer: BuyerLogin): Promise<SandboxPanelLogin> {
  const term = (name: string): Locator => page.locator("dt", { hasText: name });
  const value = (name: string): Locator =>
    term(name).locator("xpath=following-sibling::dd[1]").first();
  if ((await term("PayPal email").count()) > 0) {
    const email = (await value("PayPal email").textContent({ timeout: READ_MS }))?.trim();
    const password = (await value("PayPal password").textContent({ timeout: READ_MS }))?.trim();
    expect(
      email === buyer.email && password === buyer.password,
      "the sandbox panel shows the README's buyer",
    ).toBe(true);
    return "the buyer's login";
  }
  await expect(value("PayPal login")).toHaveText(LOGIN_IN_README, { timeout: READ_MS });
  return "the README's pointer";
}
