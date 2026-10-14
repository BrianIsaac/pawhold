import { z } from "zod";

import type { Money } from "@/money/currency";

import { optionalField, type PayPalClient } from "./client";
import {
  type Authorization,
  authorization,
  capture,
  paypalLink,
  REPRESENTATION,
  statusField,
  toPayPalAmount,
} from "./payments";

/*
 * The Orders v2 calls pawhold makes to hold an estimate, moved in from the
 * U0 probes (`probes/paypal.ts`) as they were, each typed by the fields the
 * sandbox returned on 12 October 2026 and the enums of PayPal's published
 * schema (developer.paypal.com/api/orders/v2/schema.json, read 12 October
 * 2026).
 */

/** `order_status`, as the schema enumerates it; others are read as themselves. */
export const orderStatus = z.enum([
  "CREATED",
  "SAVED",
  "APPROVED",
  "VOIDED",
  "COMPLETED",
  "PAYER_ACTION_REQUIRED",
]);

export type OrderStatus = z.infer<typeof orderStatus>;

/** An order, as `create`, `GET` and `authorize` return it. */
export const order = z.looseObject({
  id: z.string().min(1),
  status: statusField(orderStatus),
  links: optionalField(z.array(paypalLink)),
  payment_source: optionalField(
    z.looseObject({
      paypal: optionalField(
        z.looseObject({
          account_status: optionalField(z.string()),
          address: optionalField(z.looseObject({ country_code: optionalField(z.string()) })),
        }),
      ),
      card: optionalField(
        z.looseObject({
          brand: optionalField(z.string()),
          type: optionalField(z.string()),
          last_digits: optionalField(z.string()),
          authentication_result: optionalField(
            z.looseObject({ liability_shift: optionalField(z.string()) }),
          ),
        }),
      ),
    }),
  ),
  purchase_units: optionalField(
    z.array(
      z.looseObject({
        reference_id: optionalField(z.string()),
        custom_id: optionalField(z.string()),
        payments: optionalField(
          z.looseObject({
            authorizations: optionalField(z.array(authorization)),
            captures: optionalField(z.array(capture)),
          }),
        ),
      }),
    ),
  ),
});

export type Order = z.infer<typeof order>;

/** PayPal's own limit on an item's name: "any content beyond 127 characters [...] will be truncated". */
export const MAX_ITEM_NAME = 127;

/** One line of the order, as the owner sees it on PayPal's approval page (plan 3.3). */
export interface OrderItem {
  readonly name: string;
  /** The practice's price list code. */
  readonly sku: string;
  readonly quantity: number;
  readonly unitAmount: Money;
}

/**
 * How the owner approves the order. With `experience`, the order carries
 * `payment_source.paypal.experience_context`: with the return and cancel
 * URLs it answers with a `payer-action` link to PayPal's checkout; without
 * them it is for the JS SDK's window, which asks no shipping either (U6).
 * Without `experience`, the order has no payment source and the JS SDK's
 * buttons or card fields supply one.
 */
export interface PayPalExperience {
  readonly brandName: string;
  readonly locale: string;
  /** Where PayPal's checkout returns to; absent for the JS SDK's window, which has none. */
  readonly returnUrl?: string | undefined;
  readonly cancelUrl?: string | undefined;
}

/** What an order to authorise is made of. */
export interface AuthorizeOrderRequest {
  /** The amount to hold. */
  readonly amount: Money;
  /** The purchase unit's `reference_id`. */
  readonly referenceId: string;
  /** The purchase unit's `custom_id`, for reconciliation; not shown to the payer. */
  readonly customId: string;
  /** The purchase unit's description, shown to the payer. */
  readonly description: string;
  /** The order's idempotency key. */
  readonly requestId: string;
  /**
   * The lines the amount is made of. Their total is the `item_total`, and the
   * amount is that total less `discount` (what is already held, for an update).
   */
  readonly items?: readonly OrderItem[];
  readonly discount?: Money;
  /** Checkout by redirect to PayPal; absent for the JS SDK's buttons or card fields. */
  readonly experience?: PayPalExperience;
}

/** An order request PayPal would refuse, caught before it is sent. */
export class OrderRequestError extends Error {
  override readonly name = "OrderRequestError";
}

/**
 * Creates an `AUTHORIZE` order: for the buyer to approve through PayPal's
 * checkout (the `payer-action` link) with no shipping asked, when an
 * experience is given; else with no payment source, which the JS SDK's
 * buttons or card fields supply.
 *
 * @param client - A sandbox client.
 * @param request - The amount, its lines and the references.
 * @returns The order.
 * @throws OrderRequestError when the lines and the discount do not make the amount.
 */
export async function createAuthorizeOrder(
  client: PayPalClient,
  request: AuthorizeOrderRequest,
): Promise<Order> {
  const answer = await client.post("/v2/checkout/orders", {
    requestId: request.requestId,
    headers: REPRESENTATION,
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: request.referenceId,
          custom_id: request.customId,
          description: request.description,
          amount: orderAmount(request),
          ...(request.items ? { items: request.items.map(orderItem) } : {}),
        },
      ],
      ...(request.experience
        ? {
            payment_source: {
              paypal: {
                experience_context: {
                  brand_name: request.experience.brandName,
                  locale: request.experience.locale,
                  shipping_preference: "NO_SHIPPING",
                  user_action: "CONTINUE",
                  ...(request.experience.returnUrl
                    ? { return_url: request.experience.returnUrl }
                    : {}),
                  ...(request.experience.cancelUrl
                    ? { cancel_url: request.experience.cancelUrl }
                    : {}),
                },
              },
            },
          }
        : {}),
    },
    response: order,
  });
  return answer.body;
}

/**
 * The purchase unit's amount, with its breakdown when the lines are given:
 * PayPal requires `item_total` to equal the lines' sum and the amount to
 * equal `item_total` less `discount`.
 *
 * @param request - The order request.
 * @returns PayPal's `amount_with_breakdown`.
 * @throws OrderRequestError when the lines and the discount do not make the amount.
 */
function orderAmount(request: AuthorizeOrderRequest): Record<string, unknown> {
  const amount = toPayPalAmount(request.amount);
  if (!request.items) {
    if (request.discount) {
      throw new OrderRequestError("a discount needs the order's lines");
    }
    return amount;
  }
  const currencies = new Set([
    request.amount.currency,
    ...request.items.map((item) => item.unitAmount.currency),
    ...(request.discount ? [request.discount.currency] : []),
  ]);
  if (currencies.size !== 1) {
    throw new OrderRequestError("an order's lines, discount and amount share one currency");
  }
  const itemTotal = request.items.reduce(
    (sum, item) => sum + item.unitAmount.pence * item.quantity,
    0,
  );
  const discount = request.discount?.pence ?? 0;
  if (itemTotal - discount !== request.amount.pence) {
    throw new OrderRequestError(
      `the lines (${itemTotal} pence) less the discount (${discount} pence) are not the amount (${request.amount.pence} pence)`,
    );
  }
  return {
    ...amount,
    breakdown: {
      item_total: toPayPalAmount({ pence: itemTotal, currency: request.amount.currency }),
      ...(request.discount && discount > 0 ? { discount: toPayPalAmount(request.discount) } : {}),
    },
  };
}

/**
 * One line as PayPal's `item`: a name of at most 127 characters, a whole
 * quantity of at least one, and the unit price.
 *
 * @param item - The line.
 * @returns PayPal's `item`.
 * @throws OrderRequestError when the quantity is not a whole number of at least one.
 */
function orderItem(item: OrderItem): Record<string, unknown> {
  if (!Number.isInteger(item.quantity) || item.quantity < 1) {
    throw new OrderRequestError(`an order line's quantity is a whole number of at least one`);
  }
  const name =
    item.name.length > MAX_ITEM_NAME ? `${item.name.slice(0, MAX_ITEM_NAME - 3)}...` : item.name;
  return {
    name,
    sku: item.sku,
    quantity: String(item.quantity),
    unit_amount: toPayPalAmount(item.unitAmount),
  };
}

/**
 * The link the buyer follows to approve an order: `payer-action` when the
 * order was made with a payment source, `approve` otherwise.
 *
 * @param created - The order as created.
 * @returns The link's URL.
 * @throws Error when the order carries neither link.
 */
export function approvalUrl(created: Order): string {
  const found = created.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!found) {
    throw new Error(`order ${created.id} has no payer-action or approve link`);
  }
  return found.href;
}

/**
 * Reads an order.
 *
 * @param client - A sandbox client.
 * @param orderId - The order's id.
 * @returns The order.
 */
export async function getOrder(client: PayPalClient, orderId: string): Promise<Order> {
  return (
    await client.get(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { response: order })
  ).body;
}

/**
 * Authorises an approved order.
 *
 * @param client - A sandbox client.
 * @param orderId - The order's id.
 * @param requestId - The idempotency key.
 * @returns The order, holding its authorisation.
 */
export async function authorizeOrder(
  client: PayPalClient,
  orderId: string,
  requestId: string,
): Promise<Order> {
  const answer = await client.post(`/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
    requestId,
    headers: REPRESENTATION,
    body: {},
    response: order,
  });
  return answer.body;
}

/**
 * The single authorisation an authorised order holds.
 *
 * @param authorised - The order as `authorize` returned it.
 * @returns The authorisation.
 * @throws Error when the order holds none, or more than one.
 */
export function onlyAuthorization(authorised: Order): Authorization {
  const all = (authorised.purchase_units ?? []).flatMap((u) => u.payments?.authorizations ?? []);
  if (all.length !== 1) {
    throw new Error(`order ${authorised.id} holds ${all.length} authorisations, not one`);
  }
  return all[0]!;
}

/**
 * How the owner paid for an authorised order, from its payment source.
 *
 * @param authorised - The order as `authorize` or `GET` returned it.
 * @returns `paypal` for a PayPal account, `card` for card fields, or null when neither is named.
 */
export function paymentKindOf(authorised: Order): "paypal" | "card" | null {
  if (authorised.payment_source?.card) {
    return "card";
  }
  if (authorised.payment_source?.paypal) {
    return "paypal";
  }
  return null;
}
