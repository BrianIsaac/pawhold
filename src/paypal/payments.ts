import { z } from "zod";

import { currencyCode, type Money } from "@/money/currency";
import { fromPayPalValue, toPayPalValue } from "@/money/paypal-value";

import type { PayPalClient } from "./client";

/*
 * The Payments v2 calls pawhold makes against an authorisation and its
 * captures, moved in from the U0 probes (`probes/paypal.ts`) as they were,
 * each typed by the fields the sandbox returned on 12 October 2026 (the
 * recordings under `probes/recorded/`) and the enums of PayPal's published
 * schema (developer.paypal.com/api/payments/v2/schema.json, read 12 October
 * 2026). The objects are loose: PayPal's other fields pass through untouched.
 */

/** `Prefer: return=representation`: every POST answers with the resource. */
export const REPRESENTATION = { prefer: "return=representation" } as const;

/** PayPal's `money`: a currency code and a decimal value string. */
export const paypalAmount = z.looseObject({
  currency_code: z.string().length(3),
  value: z.string(),
});

export type PayPalAmount = z.infer<typeof paypalAmount>;

/** A HATEOAS link. Never followed: its host is the sandbox's `api.sandbox.paypal.com`, not the API's. */
export const paypalLink = z.looseObject({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
});

const statusDetails = z.looseObject({ reason: z.string() }).optional();

/**
 * A status PayPal answered with that its published schema does not list. It
 * is read as itself, as PayPal's own SDK reads it (`stringEnum(X, true)`), so
 * an answer PayPal gave still parses; the money layer flags the hold rather
 * than act on a status it cannot know (`knownStatus` in `@/money/holds`).
 */
const unknownStatus = z.string().min(1).brand<"UnknownPayPalStatus">();

export type UnknownStatus = z.infer<typeof unknownStatus>;

/**
 * A status field: one of the statuses the schema lists, else read as itself.
 *
 * @param listed - The statuses PayPal's published schema lists.
 * @returns The field's schema.
 */
export function statusField<T extends z.ZodEnum>(listed: T) {
  return z.union([listed, unknownStatus]);
}

/**
 * Whether a status PayPal answered with is one its published schema lists.
 *
 * @param listed - The statuses the schema lists.
 * @param status - The status as read.
 * @returns True for a listed status, which then binds as its own type.
 */
export function isKnownStatus<T extends z.ZodEnum>(
  listed: T,
  status: z.output<T> | UnknownStatus,
): status is z.output<T> {
  return listed.safeParse(status).success;
}

/** `authorization_status.status`, as the schema enumerates it; others are read as themselves. */
export const authorizationStatus = z.enum([
  "CREATED",
  "CAPTURED",
  "DENIED",
  "PARTIALLY_CAPTURED",
  "VOIDED",
  "PENDING",
]);

export type AuthorizationStatus = z.infer<typeof authorizationStatus>;

/**
 * An authorisation, as `authorize`, `GET`, `void` (with a representation)
 * and `reauthorize` return it. Reauthorise's documented answer carries only
 * the new id, its status and links, so the rest is optional.
 */
export const authorization = z.looseObject({
  id: z.string().min(1),
  status: statusField(authorizationStatus),
  status_details: statusDetails,
  amount: paypalAmount.optional(),
  custom_id: z.string().optional(),
  expiration_time: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(paypalLink).optional(),
});

export type Authorization = z.infer<typeof authorization>;

/** `capture_status.status`, as the schema enumerates it; others are read as themselves. */
export const captureStatus = z.enum([
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
]);

export type CaptureStatus = z.infer<typeof captureStatus>;

/** A capture, as `capture` (with a representation) and `GET` return it. */
export const capture = z.looseObject({
  id: z.string().min(1),
  status: statusField(captureStatus),
  status_details: statusDetails,
  amount: paypalAmount.optional(),
  final_capture: z.boolean().optional(),
  custom_id: z.string().optional(),
  seller_receivable_breakdown: z
    .looseObject({
      gross_amount: paypalAmount.optional(),
      paypal_fee: paypalAmount.optional(),
      net_amount: paypalAmount.optional(),
    })
    .optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(paypalLink).optional(),
});

export type Capture = z.infer<typeof capture>;

/** `refund_status.status`, as the schema enumerates it; others are read as themselves. */
export const refundStatus = z.enum(["CANCELLED", "FAILED", "PENDING", "COMPLETED"]);

export type RefundStatus = z.infer<typeof refundStatus>;

/** A refund, as `refund` (with a representation) returns it. */
export const refund = z.looseObject({
  id: z.string().min(1),
  status: statusField(refundStatus),
  amount: paypalAmount.optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(paypalLink).optional(),
});

export type Refund = z.infer<typeof refund>;

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
    await client.get(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`, {
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
    body.amount = toPayPalAmount(request.amount);
  }
  const answer = await client.post(
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
    {
      requestId: request.requestId,
      headers: { ...REPRESENTATION, ...request.headers },
      body,
      response: capture,
    },
  );
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
  const answer = await client.post(
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
    {
      requestId,
      headers: REPRESENTATION,
      response: voided,
    },
  );
  return answer.body;
}

/**
 * Reauthorises an authorisation for its amount, or the amount given. PayPal
 * answers with a new authorisation, which later captures and voids go
 * against ("Perform any subsequent capture against the new authorization ID,
 * not the original", /payment-methods/auth-honor, read 12 October 2026).
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
  const answer = await client.post(
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/reauthorize`,
    {
      requestId,
      headers: REPRESENTATION,
      body: amount ? { amount: toPayPalAmount(amount) } : {},
      response: authorization,
    },
  );
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
  return (
    await client.get(`/v2/payments/captures/${encodeURIComponent(captureId)}`, {
      response: capture,
    })
  ).body;
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
  const answer = await client.post(
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    {
      requestId,
      headers: REPRESENTATION,
      body: amount ? { amount: toPayPalAmount(amount) } : {},
      response: refund,
    },
  );
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

/**
 * An amount PayPal answered with, as money in pence.
 *
 * @param value - PayPal's `amount`.
 * @returns The money.
 * @throws ZodError when the currency is not one pawhold works in or the value is malformed.
 */
export function moneyFromPayPal(value: PayPalAmount): Money {
  return { pence: fromPayPalValue(value.value), currency: currencyCode.parse(value.currency_code) };
}

/**
 * Money as PayPal's `amount`.
 *
 * @param amount - The money.
 * @returns PayPal's `{ currency_code, value }`.
 */
export function toPayPalAmount(amount: Money): { currency_code: string; value: string } {
  return { currency_code: amount.currency, value: toPayPalValue(amount.pence) };
}

const paypalTime = z.iso.datetime({ offset: true });

/**
 * Reads one of PayPal's times. A void's answer carries PayPal's local offset
 * (`-07:00`) where every other answer uses `Z` (U0), so times are parsed,
 * never compared as strings.
 *
 * @param value - The RFC 3339 time.
 * @returns The instant.
 * @throws ZodError when the value is not an RFC 3339 time with an offset.
 */
export function parsePayPalTime(value: string): Date {
  return new Date(paypalTime.parse(value));
}
