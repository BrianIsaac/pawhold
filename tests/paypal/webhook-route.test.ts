import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditEvent, webhookEvent } from "@/db/schema";
import { createWebhookHandler } from "@/paypal/webhook-handler";
import type { CertificateSource } from "@/paypal/webhooks";

import { connectTestDatabase } from "../support/database";
import { paypalFixtureText } from "../support/fixtures";
import { createTestSigner } from "../support/webhook-signing";

const { db } = connectTestDatabase();
const signer = createTestSigner();
const WEBHOOK_ID = "0NH55953DH663215D";
const certificates: CertificateSource = { get: async () => signer.certificate };

const handler = createWebhookHandler({ db, webhookId: WEBHOOK_ID, certificates });

/**
 * A delivery to the listener, as PayPal would post it.
 *
 * @param body - The raw body.
 * @param headers - The delivery's headers.
 * @returns The request.
 */
function delivery(body: string | Buffer, headers: Record<string, string>): Request {
  return new Request("https://pawhold.test/api/paypal/webhook", {
    method: "POST",
    headers,
    body: new Uint8Array(Buffer.from(body)),
  });
}

/**
 * A documented sample with its event id made unique to the test, so tests
 * sharing the database never collide on PayPal's sample ids.
 *
 * @param fixture - The sample's file under `webhooks/`.
 * @param suffix - What to append to the event id.
 * @returns The raw body and its event id.
 */
function sample(fixture: string, suffix: string): { body: string; eventId: string } {
  const text = paypalFixtureText(`webhooks/${fixture}`);
  const original = (JSON.parse(text) as { id: string }).id;
  const eventId = `${original}-${suffix}`;
  return { body: text.replace(`"id":"${original}"`, `"id":"${eventId}"`), eventId };
}

const storedRows = (eventId: string) =>
  db.select().from(webhookEvent).where(eq(webhookEvent.eventId, eventId));

describe("POST /api/paypal/webhook", () => {
  it("verifies PayPal's documented authorisation event and stores it, then answers 200", async () => {
    const { body, eventId } = sample("payment-authorization-created.json", "stored");

    const answer = await handler(
      delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })),
    );

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ status: "stored" });
    const [row] = await storedRows(eventId);
    expect(row).toMatchObject({
      eventType: "PAYMENT.AUTHORIZATION.CREATED",
      resourceType: "authorization",
      resourceId: "91T13242G72341823",
      verification: "signature",
      isMock: false,
      rawBody: body,
    });
    const audit = await db.select().from(auditEvent).where(eq(auditEvent.webhookEventId, eventId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: "paypal_webhook",
      action: "paypal.webhook.received",
      webhookVerified: true,
      paypalAuthorizationId: "91T13242G72341823",
      paypalOrderId: "91A92299SF4077927",
    });
  });

  it("keeps the delivery's transmission signature, so a stored delivery can be verified again (U0's P8)", async () => {
    const { body, eventId } = sample("payment-authorization-created.json", "signature-kept");
    const headers = signer.headersFor(body, { webhookId: WEBHOOK_ID });

    await handler(delivery(body, headers));

    const [row] = await storedRows(eventId);
    expect(row!.transmissionSig).toBe(headers["paypal-transmission-sig"]);
    expect(row!.transmissionTime).toBe(headers["paypal-transmission-time"]);
    expect(row!.certUrl).toBe(headers["paypal-cert-url"]);
    expect(row!.authAlgo).toBe(headers["paypal-auth-algo"]);
  });

  it("hands each new event to reconciliation once stored, and answers 200 even when reconciliation fails", async () => {
    const handed: string[] = [];
    const reconciling = createWebhookHandler({
      db,
      webhookId: WEBHOOK_ID,
      certificates,
      onStored: async (stored) => {
        handed.push(stored);
        throw new Error("reconciliation is down");
      },
    });
    const { body, eventId } = sample("payment-capture-completed.json", "handed-on");

    const first = await reconciling(
      delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })),
    );
    const again = await reconciling(
      delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })),
    );

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(handed).toEqual([eventId]);
  });

  it("stores a replayed event id once and answers 200 to each delivery", async () => {
    const { body, eventId } = sample("payment-capture-completed.json", "replayed");

    const first = await handler(delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })));
    const again = await handler(delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })));

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(await storedRows(eventId)).toHaveLength(1);
    const audit = await db.select().from(auditEvent).where(eq(auditEvent.webhookEventId, eventId));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.paypalCaptureId).toBe("27C890397M291943E");
  });

  it("refuses the same body with one byte changed, 400, and stores nothing", async () => {
    const { body, eventId } = sample("payment-capture-completed.json", "tampered");
    const headers = signer.headersFor(body, { webhookId: WEBHOOK_ID });
    const tampered = Buffer.from(body);
    const at = body.indexOf('"value":"') + '"value":"'.length;
    tampered[at] = tampered[at] === 0x39 ? 0x38 : 0x39;

    const answer = await handler(delivery(tampered, headers));

    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "signature_mismatch" });
    expect(await storedRows(eventId)).toHaveLength(0);
  });

  it("refuses a certificate URL off PayPal's host, 400", async () => {
    const { body, eventId } = sample("payment-capture-refunded.json", "off-host");
    const headers = signer.headersFor(body, {
      webhookId: WEBHOOK_ID,
      certUrl: "https://api.sandbox.paypal.com.attacker.example/v1/notifications/certs/CERT-1",
    });

    const answer = await handler(delivery(body, headers));

    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "cert_url_not_paypal" });
    expect(await storedRows(eventId)).toHaveLength(0);
  });

  it("accepts a simulator mock event by self verification with WEBHOOK_ID when allowed, marked as mock", async () => {
    const mockAware = createWebhookHandler({
      db,
      webhookId: WEBHOOK_ID,
      certificates,
      acceptMockEvents: true,
    });
    const { body, eventId } = sample("payment-authorization-voided.json", "mock");

    const refused = await handler(
      delivery(body, signer.headersFor(body, { webhookId: "WEBHOOK_ID" })),
    );
    const accepted = await mockAware(
      delivery(body, signer.headersFor(body, { webhookId: "WEBHOOK_ID" })),
    );

    expect(refused.status).toBe(400);
    expect(accepted.status).toBe(200);
    const [row] = await storedRows(eventId);
    expect(row).toMatchObject({ isMock: true, verification: "signature" });
  });

  it("answers 503, so PayPal redelivers, when the certificate cannot be had", async () => {
    const down = createWebhookHandler({
      db,
      webhookId: WEBHOOK_ID,
      certificates: {
        get: async () => {
          const { CertificateUnavailableError } = await import("@/paypal/webhooks");
          throw new CertificateUnavailableError("down");
        },
      },
    });
    const { body, eventId } = sample("payment-capture-declined.json", "cert-down");

    const answer = await down(delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })));

    expect(answer.status).toBe(503);
    expect(await storedRows(eventId)).toHaveLength(0);
  });

  it("stores a verified event whose create_time is not a timestamp, with the time left empty", async () => {
    const { body: original, eventId } = sample("payment-capture-refunded.json", "odd-time");
    const body = original.replace(/"create_time":"[^"]*"/, '"create_time":"yesterday"');

    const answer = await handler(
      delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })),
    );

    expect(answer.status).toBe(200);
    const [row] = await storedRows(eventId);
    expect(row!.eventCreatedAt).toBeNull();
  });

  it("refuses a body that is not UTF-8 JSON, 400", async () => {
    const body = Buffer.from([0x7b, 0xff, 0x7d]);

    const answer = await handler(
      delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })),
    );

    expect(answer.status).toBe(400);
  });

  it("refuses a verified body that is not a webhook event, 400", async () => {
    const body = JSON.stringify({ hello: "world" });

    const answer = await handler(
      delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })),
    );

    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "event_invalid" });
  });

  it("refuses a body over the size limit, 413, before verifying it", async () => {
    const body = "x".repeat(2 * 1024 * 1024);

    const answer = await handler(
      delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })),
    );

    expect(answer.status).toBe(413);
  });

  it("answers 500, so PayPal redelivers, when the store fails", async () => {
    const broken = createWebhookHandler({
      db: {
        transaction: async () => {
          throw new Error("the database is down");
        },
      } as unknown as typeof db,
      webhookId: WEBHOOK_ID,
      certificates,
    });
    const { body } = sample("payment-capture-pending.json", "store-fails");

    const answer = await broken(delivery(body, signer.headersFor(body, { webhookId: WEBHOOK_ID })));

    expect(answer.status).toBe(500);
  });
});
