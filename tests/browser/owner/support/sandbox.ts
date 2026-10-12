import { inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { hold } from "@/db/schema";
import { createPayPalClient, type PayPalClient } from "@/paypal/client";
import { getOrder } from "@/paypal/orders";
import { getAuthorization, voidAuthorization } from "@/paypal/payments";
import { paypalRequestId } from "@/paypal/request-id";

import type { BuyerLogin } from "../../../../probes/buyer";
import { retryingFetch } from "../../../../probes/retry";

import { SEEDED_ID_PREFIX } from "./cases";

/*
 * The owner's walks against PayPal's sandbox: skipped without
 * PAYPAL_CLIENT_ID. The webhook's tick is waited for only when a webhook
 * subscription reaches this run's server (PAWHOLD_BROWSER_WEBHOOK=reachable:
 * a tunnel and a subscription whose id is the server's PAYPAL_WEBHOOK_ID).
 * Every hold a walk makes is voided at the end, as U3's integration suite
 * does.
 */

/** Whether the sandbox app's credentials are in the environment. */
export const sandboxConfigured = Boolean(
  process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET,
);

/** Whether PayPal's webhook reaches this run's server. */
export const webhookReachable = process.env.PAWHOLD_BROWSER_WEBHOOK === "reachable";

/** P6's card: the GB 3DS "Test Case 1" Visa from PayPal's testing page (U0's decision 13). */
export const TEST_CARD = {
  name: "Sam Carter",
  number: "4462603042343024",
  expiry: "12/30",
  cvv: "123",
} as const;

/**
 * The GB sandbox buyer's login, from the environment.
 *
 * @returns The login.
 * @throws Error when it is not set.
 */
export function buyerLogin(): BuyerLogin {
  const email = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
  const password = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
  if (!email || !password) {
    throw new Error("the sandbox walks need PAYPAL_SANDBOX_BUYER_EMAIL and _PASSWORD");
  }
  return { email, password };
}

/**
 * What must never reach a log or an error: the credentials and the login.
 *
 * @returns The values.
 */
export function sandboxSecrets(): string[] {
  return [
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET,
    process.env.PAYPAL_SANDBOX_BUYER_EMAIL,
    process.env.PAYPAL_SANDBOX_BUYER_PASSWORD,
  ].filter((value): value is string => Boolean(value));
}

/**
 * The sandbox client the clean-up voids with, retrying requests that got no
 * answer (U0's decision 6).
 *
 * @returns The client.
 */
function sandboxClient(): PayPalClient {
  return createPayPalClient({
    clientId: process.env.PAYPAL_CLIENT_ID!,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
    environment: "sandbox",
    timeoutMs: 90_000,
    fetch: retryingFetch(fetch, { attempts: 4, delayMs: 2_000 }),
  });
}

/**
 * Voids every authorisation the practices' holds left standing, those whose
 * authorise answer pawhold never recorded included, and answers what is
 * still held after (which should be nothing). Seeded holds were never
 * PayPal's and are passed over.
 *
 * @param db - The run's database.
 * @param practiceIds - The practices the walks made.
 * @returns The authorisations still held.
 */
export async function voidWhatTheWalksHeld(
  db: Database["db"],
  practiceIds: readonly string[],
): Promise<string[]> {
  if (practiceIds.length === 0) {
    return [];
  }
  const paypal = sandboxClient();
  const holds = await db
    .select()
    .from(hold)
    .where(inArray(hold.practiceId, [...practiceIds]));
  const stillHeld: string[] = [];
  for (const one of holds.filter((made) => !made.paypalOrderId.startsWith(SEEDED_ID_PREFIX))) {
    const unrecorded =
      one.authorizationId === null
        ? ((await getOrder(paypal, one.paypalOrderId)).purchase_units?.flatMap(
            (unit) => unit.payments?.authorizations?.map((found) => found.id) ?? [],
          ) ?? [])
        : [];
    const ids = [...new Set([one.authorizationId, ...unrecorded])].filter(
      (id): id is string => id !== null,
    );
    for (const id of ids) {
      const read = await getAuthorization(paypal, id);
      if (read.status === "CREATED" || read.status === "PARTIALLY_CAPTURED") {
        await voidAuthorization(
          paypal,
          id,
          paypalRequestId({ caseId: one.caseId, holdId: one.id, step: "void.cleanup" }),
        );
      }
      const after = await getAuthorization(paypal, id);
      if (after.status === "CREATED" || after.status === "PARTIALLY_CAPTURED") {
        stillHeld.push(`${id} (${after.status})`);
      }
    }
  }
  return stillHeld;
}
