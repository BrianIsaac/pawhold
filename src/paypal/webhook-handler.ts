import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Database } from "@/db/client";
import { webhookEvent } from "@/db/schema";

import type { PayPalClient } from "./client";
import { readTransmissionHeaders, verifyWebhook, type CertificateSource } from "./webhooks";

/** PayPal's events are a few kilobytes; anything near this is not one. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

/** The envelope every webhook event carries (the Webhooks v1 `event` schema). */
const webhookEnvelope = z.object({
  id: z.string().min(1).max(255),
  event_type: z.string().min(1).max(255),
  resource_type: z.string().max(255).optional(),
  summary: z.string().optional(),
  create_time: z.string().optional(),
  resource: z.record(z.string(), z.unknown()).optional(),
});

type WebhookEnvelope = z.infer<typeof webhookEnvelope>;

/** The PayPal ids an event's resource carries, for the audit trail. */
const resourceIds = z.object({
  id: z.string().optional(),
  supplementary_data: z
    .object({
      related_ids: z
        .object({
          order_id: z.string().optional(),
          authorization_id: z.string().optional(),
          capture_id: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

/** What the listener needs. */
export interface WebhookHandlerDependencies {
  readonly db: Database["db"];
  /** The id PayPal gave the subscription to this listener. */
  readonly webhookId: string;
  readonly certificates: CertificateSource;
  /** A client for the verify endpoint, the fallback when no certificate can be had. */
  readonly postback?: PayPalClient;
  /** Accept the simulator's mock events (never in the judged deployment). */
  readonly acceptMockEvents?: boolean;
  /**
   * Called with the event id once a new event is stored and committed: the
   * money lifecycle reconciles it against the case's state (U3). A failure
   * here is logged and never fails the delivery: the event is stored, and
   * the hourly job reconciles what is left.
   */
  readonly onStored?: (eventId: string) => Promise<void>;
}

/**
 * Builds the webhook listener: reads the raw body, verifies it, stores the
 * event by PayPal's event id with its audit event in one transaction, and
 * answers 200 only after the commit. A replayed event id is stored once and
 * answered 200, so PayPal stops redelivering. A refusal is 400; a failure on
 * this side (no certificate, no database) is 5xx, so PayPal retries ("up to
 * 25 times over 3 days").
 *
 * @param dependencies - The database, the webhook id and the verifiers.
 * @returns The request handler.
 */
export function createWebhookHandler(
  dependencies: WebhookHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_WEBHOOK_BYTES) {
      return answer(413, { error: "body_too_large" });
    }
    const rawBody = await readCapped(request, MAX_WEBHOOK_BYTES);
    if (rawBody === null) {
      return answer(413, { error: "body_too_large" });
    }

    const verification = await verifyWebhook({
      rawBody,
      headers: request.headers,
      webhookId: dependencies.webhookId,
      certificates: dependencies.certificates,
      ...(dependencies.postback ? { postback: dependencies.postback } : {}),
      acceptMockEvents: dependencies.acceptMockEvents ?? false,
    });
    const transmissionId = request.headers.get("paypal-transmission-id");
    if (verification.outcome === "refused") {
      console.warn("pawhold: webhook refused", { reason: verification.reason, transmissionId });
      return answer(400, { error: verification.reason });
    }
    if (verification.outcome === "unavailable") {
      console.error("pawhold: webhook not verifiable now", {
        reason: verification.reason,
        transmissionId,
      });
      return answer(503, { error: verification.reason });
    }

    let text: string;
    let envelope: WebhookEnvelope;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
      envelope = webhookEnvelope.parse(JSON.parse(text));
    } catch {
      console.warn("pawhold: verified webhook is not an event", { transmissionId });
      return answer(400, { error: "event_invalid" });
    }

    try {
      const stored = await storeEvent(dependencies.db, {
        envelope,
        text,
        headers: request.headers,
        method: verification.method,
        isMock: verification.isMock,
      });
      if (stored && dependencies.onStored) {
        try {
          await dependencies.onStored(envelope.id);
        } catch (error) {
          console.error("pawhold: webhook stored but not reconciled", {
            eventId: envelope.id,
            error,
          });
        }
      }
      return answer(200, { status: stored ? "stored" : "duplicate" });
    } catch (error) {
      console.error("pawhold: webhook store failed", { eventId: envelope.id, error });
      return answer(500, { error: "store_failed" });
    }
  };
}

/**
 * Stores a verified event and its audit event in one transaction.
 *
 * @param db - The database.
 * @param event - The event, its raw text and how it was verified.
 * @param event.envelope - The parsed envelope.
 * @param event.text - The body exactly as received.
 * @param event.headers - The delivery's headers.
 * @param event.method - How it was verified.
 * @param event.isMock - Whether it is a simulator mock event.
 * @returns True when it was new, false when its event id was already stored.
 */
async function storeEvent(
  db: Database["db"],
  event: {
    envelope: WebhookEnvelope;
    text: string;
    headers: Headers;
    method: "signature" | "postback";
    isMock: boolean;
  },
): Promise<boolean> {
  const transmission = readTransmissionHeaders(event.headers);
  if (!transmission) {
    throw new Error("a verified delivery lost its transmission headers");
  }
  const { envelope } = event;
  const resource = resourceIds.safeParse(envelope.resource ?? {});
  const resourceId = resource.success ? (resource.data.id ?? null) : null;
  const related = resource.success ? resource.data.supplementary_data?.related_ids : undefined;

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(webhookEvent)
      .values({
        eventId: envelope.id,
        eventType: envelope.event_type,
        resourceType: envelope.resource_type ?? null,
        resourceId,
        summary: envelope.summary ?? null,
        eventCreatedAt: timestampOrNull(envelope.create_time),
        transmissionId: transmission.transmissionId,
        transmissionTime: transmission.transmissionTime,
        certUrl: transmission.certUrl,
        authAlgo: transmission.authAlgo,
        transmissionSig: transmission.transmissionSig,
        verification: event.method,
        isMock: event.isMock,
        rawBody: event.text,
        payload: JSON.parse(event.text) as unknown,
      })
      .onConflictDoNothing({ target: webhookEvent.eventId })
      .returning({ eventId: webhookEvent.eventId });
    if (inserted.length === 0) {
      return false;
    }

    const own = (type: string) => (envelope.resource_type === type ? resourceId : null);
    const paypal = Object.fromEntries(
      Object.entries({
        orderId: own("checkout-order") ?? related?.order_id,
        authorizationId: own("authorization") ?? related?.authorization_id,
        captureId: own("capture") ?? related?.capture_id,
        refundId: own("refund"),
      }).filter(([, value]) => typeof value === "string"),
    );
    await appendAuditEvent(tx, {
      actor: "paypal_webhook",
      action: "paypal.webhook.received",
      paypal,
      webhook: { eventId: envelope.id, verified: true },
      detail: {
        eventType: envelope.event_type,
        resourceType: envelope.resource_type ?? null,
        verification: event.method,
        isMock: event.isMock,
        transmissionId: transmission.transmissionId,
      },
    });
    return true;
  });
}

/**
 * Reads PayPal's `create_time`, which is metadata: a value that is not an
 * RFC 3339 timestamp is stored as null rather than refusing the event.
 *
 * @param value - The event's `create_time`.
 * @returns The time, or null.
 */
function timestampOrNull(value: string | undefined): Date | null {
  if (value === undefined || !z.iso.datetime({ offset: true }).safeParse(value).success) {
    return null;
  }
  return new Date(value);
}

/**
 * Reads a request's body, stopping as soon as it passes the limit, so an
 * oversized body is never held whole.
 *
 * @param request - The request.
 * @param limit - The most bytes to accept.
 * @returns The body, or null when it is over the limit.
 */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * A JSON answer.
 *
 * @param status - The HTTP status.
 * @param body - The body.
 * @returns The response.
 */
function answer(status: number, body: Record<string, string>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
