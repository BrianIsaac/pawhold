import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { CurrencyCode } from "@/money/currency";
import { toPayPalValue } from "@/money/paypal-value";

import type { PayPalClient } from "./client";

const createdOrder = z.object({ id: z.string().min(1), status: z.string().min(1) });

/**
 * Creates a £1.00 (or $1.00) order to authorise, for the deployment check
 * "an order created from the deployed app appears in the sandbox" (U1's
 * acceptance). Nothing is approved or captured: the order is left
 * unapproved, so nothing is held.
 *
 * @param client - A sandbox PayPal client.
 * @param currency - GBP (D1), or USD on its branch.
 * @returns The order's id and status.
 */
export async function createSmokeOrder(
  client: PayPalClient,
  currency: CurrencyCode,
): Promise<z.infer<typeof createdOrder>> {
  const answer = await client.post("/v2/checkout/orders", {
    requestId: randomUUID(),
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "pawhold-deployment-check",
          description: "pawhold deployment check (sandbox)",
          amount: { currency_code: currency, value: toPayPalValue(100) },
        },
      ],
    },
    response: createdOrder,
  });
  return { id: answer.body.id, status: answer.body.status };
}
