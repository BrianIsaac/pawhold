import { expect, type Page } from "@playwright/test";

import { DOUBLE_URL } from "./discharge";

/**
 * The owner's PayPal approval played at the run's PayPal double, as PayPal's
 * SDK would ask the server: the page's order is made, the double approves it
 * as the buyer would in PayPal's window, the server is asked to authorise,
 * and the page is read again.
 *
 * @param page - The owner's page, at their link.
 * @throws Error when the run has no double (it talks to PayPal's sandbox).
 */
export async function approveAtTheDouble(page: Page): Promise<void> {
  if (!DOUBLE_URL) {
    throw new Error("the approval at the double needs the run's PayPal double");
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
