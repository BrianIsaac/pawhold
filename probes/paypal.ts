import { z } from "zod";

import type { Money } from "@/money/currency";
import { fromPayPalValue, toPayPalValue } from "@/money/paypal-value";
import type { PayPalClient } from "@/paypal/client";

/*
 * The Orders v2 and Payments v2 calls the probes make, each typed by the
 * fields the probes read (the schemas are loose: PayPal's other fields pass
 * through untouched). These are the calls U3's `src/paypal/orders.ts` and
 * `payments.ts` will own; the shapes here are the ones the sandbox returned
 * on 12 October 2026.
 */

/** Where the buyer's browser is sent after approving; intercepted, never fetched. */
export const RETURN_URL = "https://example.com/pawhold-probes/return";
export const CANCEL_URL = "https://example.com/pawhold-probes/cancel";

const amount = z.looseObject({
  currency_code: z.string().length(3),
  value: z.string(),
});

const link = z.looseObject({ href: z.string(), rel: z.string(), method: z.string().optional() });

const statusDetails = z.looseObject({ reason: z.string() }).optional();

/** An authorisation, as `authorize`, `GET` and `reauthorize` return it. */
export const authorization = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1),
  status_details: statusDetails,
  amount: amount.optional(),
  expiration_time: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(link).optional(),
});

export type Authorization = z.infer<typeof authorization>;

/** A capture, as `capture` (with `Prefer: return=representation`) and `GET` return it. */
export const capture = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1),
  status_details: statusDetails,
  amount: amount.optional(),
  final_capture: z.boolean().optional(),
  seller_receivable_breakdown: z
    .looseObject({
      gross_amount: amount.optional(),
      paypal_fee: amount.optional(),
      net_amount: amount.optional(),
    })
    .optional(),
  create_time: z.string().optional(),
  links: z.array(link).optional(),
});

export type Capture = z.infer<typeof capture>;

/** A refund, as `refund` returns it. */
export const refund = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1),
  amount: amount.optional(),
});

export type Refund = z.infer<typeof refund>;

/** An order, as `create`, `GET` and `authorize` return it. */
export const order = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1),
  links: z.array(link).optional(),
  payment_source: z
    .looseObject({
      paypal: z
        .looseObject({
          account_status: z.string().optional(),
          address: z.looseObject({ country_code: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
  purchase_units: z
    .array(
      z.looseObject({
        reference_id: z.string().optional(),
        payments: z
          .looseObject({
            authorizations: z.array(authorization).optional(),
            captures: z.array(capture).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export type Order = z.infer<typeof order>;

const REPRESENTATION = { prefer: "return=representation" } as const;

/** What an order to authorise is made of. */
export interface AuthorizeOrderRequest {
  /** The amount to hold. */
  readonly amount: Money;
  /** The purchase unit's `reference_id`. */
  readonly referenceId: string;
  /** The purchase unit's `custom_id` (the probe and run, for reconciliation). */
  readonly customId: string;
  /** The order's idempotency key. */
  readonly requestId: string;
}

/**
 * Creates an `AUTHORIZE` order for the buyer to approve with their PayPal
 * account, returning to `RETURN_URL` with no shipping asked.
 *
 * @param client - A sandbox client.
 * @param request - The amount and the references.
 * @returns The order, with its `payer-action` link.
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
          description: "pawhold sandbox probe",
          amount: {
            currency_code: request.amount.currency,
            value: toPayPalValue(request.amount.pence),
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "pawhold probes",
            locale: "en-GB",
            shipping_preference: "NO_SHIPPING",
            user_action: "CONTINUE",
            return_url: RETURN_URL,
            cancel_url: CANCEL_URL,
          },
        },
      },
    },
    response: order,
  });
  return answer.body;
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
  return (await client.get(`/v2/checkout/orders/${orderId}`, { response: order })).body;
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
  const answer = await client.post(`/v2/checkout/orders/${orderId}/authorize`, {
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
 * Reads an authorisation.
 *
 * @param client - A sandbox client.
 * @param authorizationId - The authorisation's id.
 * @returns The authorisation.
 */
export async function getAuthorization(
  client: PayPalClient,
  authorizationId: string,
): Promise<Authorization> {
  return (
    await client.get(`/v2/payments/authorizations/${authorizationId}`, {
      response: authorization,
    })
  ).body;
}

/** A capture against an authorisation. */
export interface CaptureRequest {
  /** The amount; the whole authorisation when absent. */
  readonly amount?: Money;
  /** `final_capture`: whether no further capture is intended. */
  readonly finalCapture: boolean;
  readonly requestId: string;
  /** Extra headers, such as negative testing's `PayPal-Mock-Response`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Captures an authorisation in whole or in part.
 *
 * @param client - A sandbox client.
 * @param authorizationId - The authorisation's id.
 * @param request - The amount and `final_capture`.
 * @returns The capture.
 */
export async function captureAuthorization(
  client: PayPalClient,
  authorizationId: string,
  request: CaptureRequest,
): Promise<Capture> {
  const body: Record<string, unknown> = { final_capture: request.finalCapture };
  if (request.amount) {
    body.amount = {
      currency_code: request.amount.currency,
      value: toPayPalValue(request.amount.pence),
    };
  }
  const answer = await client.post(`/v2/payments/authorizations/${authorizationId}/capture`, {
    requestId: request.requestId,
    headers: { ...REPRESENTATION, ...request.headers },
    body,
    response: capture,
  });
  return answer.body;
}

/** What a void answers: the authorisation (with a representation), or nothing (204). */
const voided = z.union([authorization, z.null()]);

/**
 * Voids an authorisation (the whole of what is left of it).
 *
 * @param client - A sandbox client.
 * @param authorizationId - The authorisation's id.
 * @param requestId - The idempotency key.
 * @returns The voided authorisation, or null when PayPal answered with no body.
 */
export async function voidAuthorization(
  client: PayPalClient,
  authorizationId: string,
  requestId: string,
): Promise<Authorization | null> {
  const answer = await client.post(`/v2/payments/authorizations/${authorizationId}/void`, {
    requestId,
    headers: REPRESENTATION,
    response: voided,
  });
  return answer.body;
}

/**
 * Reauthorises an authorisation for its amount, or the amount given.
 *
 * @param client - A sandbox client.
 * @param authorizationId - The authorisation's id.
 * @param requestId - The idempotency key.
 * @param amount - The amount to reauthorise; the original when absent.
 * @returns The new authorisation.
 */
export async function reauthorizeAuthorization(
  client: PayPalClient,
  authorizationId: string,
  requestId: string,
  amount?: Money,
): Promise<Authorization> {
  const answer = await client.post(`/v2/payments/authorizations/${authorizationId}/reauthorize`, {
    requestId,
    headers: REPRESENTATION,
    body: amount
      ? { amount: { currency_code: amount.currency, value: toPayPalValue(amount.pence) } }
      : {},
    response: authorization,
  });
  return answer.body;
}

/**
 * Reads a capture.
 *
 * @param client - A sandbox client.
 * @param captureId - The capture's id.
 * @returns The capture.
 */
export async function getCapture(client: PayPalClient, captureId: string): Promise<Capture> {
  return (await client.get(`/v2/payments/captures/${captureId}`, { response: capture })).body;
}

/**
 * Refunds a capture in whole, or in part when an amount is given.
 *
 * @param client - A sandbox client.
 * @param captureId - The capture's id.
 * @param requestId - The idempotency key.
 * @param amount - The part to refund; the whole when absent.
 * @returns The refund.
 */
export async function refundCapture(
  client: PayPalClient,
  captureId: string,
  requestId: string,
  amount?: Money,
): Promise<Refund> {
  const answer = await client.post(`/v2/payments/captures/${captureId}/refund`, {
    requestId,
    headers: REPRESENTATION,
    body: amount
      ? { amount: { currency_code: amount.currency, value: toPayPalValue(amount.pence) } }
      : {},
    response: refund,
  });
  return answer.body;
}

/**
 * An amount PayPal answered with, in pence.
 *
 * @param value - PayPal's `amount`, when present.
 * @returns The pence, or null when PayPal gave no amount.
 */
export function pence(value: { value: string } | undefined): number | null {
  return value ? fromPayPalValue(value.value) : null;
}
