import type { Money } from "@/money/currency";
import type { PayPalClient } from "@/paypal/client";
import { createAuthorizeOrder, type Order, type PayPalExperience } from "@/paypal/orders";

/*
 * The probes' own orders: a bare amount with no lines, approved through
 * PayPal's checkout by the headless buyer (returning to a URL that is
 * intercepted, never fetched), or left with no payment source for the card
 * fields. The calls themselves are U3's, in `src/paypal/`.
 */

/** Where the buyer's browser is sent after approving; intercepted, never fetched. */
export const RETURN_URL = "https://example.com/pawhold-probes/return";
export const CANCEL_URL = "https://example.com/pawhold-probes/cancel";

/** The checkout the probes' wallet orders send the buyer to. */
export const PROBE_EXPERIENCE: PayPalExperience = {
  brandName: "pawhold probes",
  locale: "en-GB",
  returnUrl: RETURN_URL,
  cancelUrl: CANCEL_URL,
};

/** What a probe's order to authorise is made of. */
export interface ProbeOrderRequest {
  /** The amount to hold. */
  readonly amount: Money;
  /** The purchase unit's `reference_id`. */
  readonly referenceId: string;
  /** The purchase unit's `custom_id` (the probe and run, for reconciliation). */
  readonly customId: string;
  /** The order's idempotency key. */
  readonly requestId: string;
  /**
   * How the buyer pays: `paypal` sends them to PayPal's checkout (the
   * `payer-action` link); `card` leaves the payment source to the card
   * fields' submit.
   */
  readonly payWith?: "paypal" | "card";
}

/**
 * Creates a probe's `AUTHORIZE` order.
 *
 * @param client - A sandbox client.
 * @param request - The amount and the references.
 * @returns The order, with its `payer-action` link when paid with PayPal.
 */
export function createProbeOrder(client: PayPalClient, request: ProbeOrderRequest): Promise<Order> {
  return createAuthorizeOrder(client, {
    amount: request.amount,
    referenceId: request.referenceId,
    customId: request.customId,
    description: "pawhold sandbox probe",
    requestId: request.requestId,
    ...(request.payWith === "card" ? {} : { experience: PROBE_EXPERIENCE }),
  });
}
