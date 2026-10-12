import { randomUUID } from "node:crypto";

import type { Database } from "@/db/client";
import { webhookEvent } from "@/db/schema";

import { paypalFixtureText } from "./fixtures";

/** PayPal's documented sample of each event type, under `tests/fixtures/paypal/webhooks/`. */
const SAMPLES = {
  "PAYMENT.AUTHORIZATION.CREATED": "payment-authorization-created.json",
  "PAYMENT.AUTHORIZATION.VOIDED": "payment-authorization-voided.json",
  "PAYMENT.CAPTURE.COMPLETED": "payment-capture-completed.json",
  "PAYMENT.CAPTURE.DECLINED": "payment-capture-declined.json",
  "PAYMENT.CAPTURE.PENDING": "payment-capture-pending.json",
  "PAYMENT.CAPTURE.REFUNDED": "payment-capture-refunded.json",
} as const;

export type SampledEventType = keyof typeof SAMPLES;

/**
 * Stores a verified delivery as U1's listener stores one, PayPal's sample for
 * the event type with its resource id made the one given, ready for U3's
 * `reconcileWebhookEvent` (which the listener calls after storing). A test
 * cannot post a signed delivery to the server: its certificate must be
 * fetched from PayPal's own host.
 *
 * @param db - The database.
 * @param eventType - The event's type.
 * @param resourceId - The resource's PayPal id.
 * @param receivedAt - When the listener stored it; now by default.
 * @returns The event's id.
 */
export async function storeDelivery(
  db: Database["db"],
  eventType: SampledEventType,
  resourceId: string,
  receivedAt: Date = new Date(),
): Promise<string> {
  const eventId = `WH-${randomUUID()}`;
  const sample = JSON.parse(paypalFixtureText(`webhooks/${SAMPLES[eventType]}`)) as Record<
    string,
    unknown
  >;
  const payload = {
    ...sample,
    id: eventId,
    event_type: eventType,
    resource: { ...(sample.resource as Record<string, unknown>), id: resourceId },
  };
  await db.insert(webhookEvent).values({
    eventId,
    eventType,
    resourceType: String(sample.resource_type),
    resourceId,
    transmissionId: randomUUID(),
    transmissionTime: receivedAt.toISOString(),
    transmissionSig: "c2lnbmF0dXJl",
    certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test",
    authAlgo: "SHA256withRSA",
    verification: "signature",
    isMock: false,
    rawBody: JSON.stringify(payload),
    payload,
    receivedAt,
  });
  return eventId;
}
