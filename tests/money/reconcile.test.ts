import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent, capture, hold, webhookEvent } from "@/db/schema";
import {
  type EstimateVersionView,
  loadEstimateVersion,
  makeEstimateVersion,
} from "@/estimate/version";
import { discharge } from "@/money/discharge";
import { authoriseHold, orderHold, sendEstimate } from "@/money/holds";
import { reconcilePendingWebhooks, reconcileWebhookEvent } from "@/money/reconcile";
import { refundCaptured } from "@/money/refunds";
import { caseMoney } from "@/money/view";

import { connectTestDatabase } from "../support/database";
import { paypalFixtureText } from "../support/fixtures";
import { DENTAL_LINES, makeDentalCase, type MoneyFixture } from "../support/money";
import { startPayPalDouble } from "../support/paypal-double";

const { db } = connectTestDatabase();
const paypal = startPayPalDouble();

let fixture: MoneyFixture;
let version: EstimateVersionView;
let authorizationId: string;
let orderId: string;

const SAMPLES = {
  "PAYMENT.AUTHORIZATION.CREATED": "payment-authorization-created.json",
  "PAYMENT.AUTHORIZATION.VOIDED": "payment-authorization-voided.json",
  "PAYMENT.CAPTURE.COMPLETED": "payment-capture-completed.json",
  "PAYMENT.CAPTURE.DECLINED": "payment-capture-declined.json",
  "PAYMENT.CAPTURE.PENDING": "payment-capture-pending.json",
  "PAYMENT.CAPTURE.REFUNDED": "payment-capture-refunded.json",
} as const;

/**
 * Stores a verified delivery as U1's listener would: PayPal's documented
 * sample for the event type, its resource id made the one given.
 *
 * @param eventType - The event's type.
 * @param resourceId - The resource's PayPal id.
 * @param options - When it was received, and whether it is a simulator mock.
 * @param options.receivedAt - When the listener stored it.
 * @param options.isMock - Whether it is a simulator mock event.
 * @param options.relatedOrderId - The order id in its supplementary data.
 * @returns The event's id.
 */
async function delivered(
  eventType: keyof typeof SAMPLES | "PAYMENT.CAPTURE.REVERSED" | "CHECKOUT.ORDER.APPROVED",
  resourceId: string,
  options: { receivedAt?: Date; isMock?: boolean; relatedOrderId?: string } = {},
): Promise<string> {
  const eventId = `WH-${randomUUID()}`;
  const sample =
    eventType in SAMPLES
      ? (JSON.parse(
          paypalFixtureText(`webhooks/${SAMPLES[eventType as keyof typeof SAMPLES]}`),
        ) as Record<string, unknown>)
      : {
          event_type: eventType,
          resource_type: eventType.startsWith("CHECKOUT") ? "checkout-order" : "capture",
          resource: {},
        };
  const resource: Record<string, unknown> = {
    ...(sample.resource as Record<string, unknown>),
    id: resourceId,
  };
  if (options.relatedOrderId) {
    resource.supplementary_data = { related_ids: { order_id: options.relatedOrderId } };
  }
  const payload = { ...sample, id: eventId, event_type: eventType, resource };
  await db.insert(webhookEvent).values({
    eventId,
    eventType,
    resourceType: String(sample.resource_type),
    resourceId,
    transmissionId: randomUUID(),
    transmissionTime: "2026-10-13T09:00:30Z",
    transmissionSig: "c2lnbmF0dXJl",
    certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test",
    authAlgo: "SHA256withRSA",
    verification: "signature",
    isMock: options.isMock ?? false,
    rawBody: JSON.stringify(payload),
    payload,
    receivedAt: options.receivedAt ?? NOW,
  });
  return eventId;
}

/**
 * The audit events about a webhook event.
 *
 * @param eventId - The event.
 * @returns The events, in order.
 */
async function eventsAbout(eventId: string) {
  return db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.webhookEventId, eventId))
    .orderBy(asc(auditEvent.id));
}

const NOW = new Date("2026-10-13T09:01:00Z");

beforeEach(async () => {
  fixture = await makeDentalCase(db);
  const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });
  await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
  const deps = { db, paypal: paypal.client() };
  const { hold: ordered } = await orderHold(deps, { ...fixture, versionId: draft.id });
  paypal.approve(ordered.paypalOrderId);
  const held = await authoriseHold(deps, { ...fixture, holdId: ordered.id });
  version = (await loadEstimateVersion(db, fixture.practiceId, draft.id))!;
  authorizationId = held.authorizationId!;
  orderId = held.paypalOrderId;
});

describe("reconciliation of PayPal's webhooks against the case's state (plan 3.2, rule 5)", () => {
  it("rule 5: the authorisation's webhook confirms the hold the API answer made, and changes nothing else", async () => {
    const eventId = await delivered("PAYMENT.AUTHORIZATION.CREATED", authorizationId);
    const before = await caseMoney(db, fixture.practiceId, fixture.caseId);

    const outcome = await reconcileWebhookEvent(db, eventId, { now: NOW });

    expect(outcome.outcome).toBe("reconciled");
    const after = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(after.state).toBe(before.state);
    expect(after.holds[0]!.confirmedAt).not.toBeNull();
    const [event] = (await eventsAbout(eventId)).filter(
      (one) => one.action === "webhook.reconciled",
    );
    expect(event).toMatchObject({
      actor: "paypal_webhook",
      caseId: fixture.caseId,
      paypalAuthorizationId: authorizationId,
      webhookVerified: true,
    });
    const [row] = await db.select().from(webhookEvent).where(eq(webhookEvent.eventId, eventId));
    expect(row!.processedAt).not.toBeNull();
  });

  it("rule 5: a webhook for a state the case is not in is recorded and flagged, never silently applied", async () => {
    // PayPal says the hold was voided, but pawhold never voided it: the case stays held.
    const eventId = await delivered("PAYMENT.AUTHORIZATION.VOIDED", authorizationId, {
      receivedAt: new Date(NOW.getTime() - 20 * 60 * 1000),
    });

    const outcome = await reconcileWebhookEvent(db, eventId, { now: NOW });

    expect(outcome.outcome).toBe("flagged");
    const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(money.state).toBe("held");
    expect(money.holds[0]!.status).toBe("authorised");
    const [event] = (await eventsAbout(eventId)).filter((one) => one.action === "webhook.flagged");
    expect(event).toMatchObject({ caseId: fixture.caseId, paypalAuthorizationId: authorizationId });
    expect(String((event!.detail as { reason: string }).reason)).toContain("open");
  });

  it("waits out a webhook that may have overtaken the API answer, then flags it", async () => {
    const eventId = await delivered("PAYMENT.CAPTURE.COMPLETED", "UNKNOWNCAPTURE01");

    expect((await reconcileWebhookEvent(db, eventId, { now: NOW })).outcome).toBe("pending");
    expect(await eventsAbout(eventId)).toHaveLength(0);

    const later = new Date(NOW.getTime() + 16 * 60 * 1000);
    expect((await reconcileWebhookEvent(db, eventId, { now: later })).outcome).toBe("flagged");
    const [event] = await eventsAbout(eventId);
    expect(event).toMatchObject({ action: "webhook.flagged", caseId: null });
  });

  it("confirms a discharge's capture, void and refund by their webhooks", async () => {
    const deps = { db, paypal: paypal.client() };
    await discharge(deps, {
      ...fixture,
      actor: "vet",
      lines: [{ estimateLineId: version.lines[0]!.id, quantity: 1 }],
    });
    const [taken] = await db.select().from(capture).where(eq(capture.holdId, version.id));
    const refunded = await refundCaptured(deps, {
      ...fixture,
      captureId: taken!.id,
      amountPence: 1_000,
      reason: "goodwill",
      actor: "vet",
    });

    const outcomes = [];
    for (const [type, id] of [
      ["PAYMENT.CAPTURE.COMPLETED", taken!.paypalCaptureId],
      ["PAYMENT.AUTHORIZATION.VOIDED", authorizationId],
      ["PAYMENT.CAPTURE.REFUNDED", refunded.paypalRefundId!],
      ["CHECKOUT.ORDER.APPROVED", orderId],
    ] as const) {
      outcomes.push(
        (await reconcileWebhookEvent(db, await delivered(type, id), { now: NOW })).outcome,
      );
    }

    expect(outcomes).toEqual(["reconciled", "reconciled", "reconciled", "reconciled"]);
    const [confirmed] = await db.select().from(capture).where(eq(capture.id, taken!.id));
    expect(confirmed!.confirmedAt).not.toBeNull();
  });

  it("applies a pending capture's completion, which the case expects", async () => {
    await discharge(
      { db, paypal: paypal.client() },
      {
        ...fixture,
        actor: "vet",
        lines: [{ estimateLineId: version.lines[0]!.id, quantity: 1 }],
      },
    );
    const [taken] = await db.select().from(capture).where(eq(capture.holdId, version.id));
    await db.update(capture).set({ status: "pending" }).where(eq(capture.id, taken!.id));

    const outcome = await reconcileWebhookEvent(
      db,
      await delivered("PAYMENT.CAPTURE.COMPLETED", taken!.paypalCaptureId),
      { now: NOW },
    );

    expect(outcome).toMatchObject({ outcome: "reconciled", applied: "capture completed" });
    const [completed] = await db.select().from(capture).where(eq(capture.id, taken!.id));
    expect(completed!.status).toBe("completed");
  });

  it("flags a declined or reversed capture: the money was not kept, and the practice must act", async () => {
    await discharge(
      { db, paypal: paypal.client() },
      {
        ...fixture,
        actor: "vet",
        lines: [{ estimateLineId: version.lines[0]!.id, quantity: 1 }],
      },
    );
    const [taken] = await db.select().from(capture).where(eq(capture.holdId, version.id));

    const declined = await reconcileWebhookEvent(
      db,
      await delivered("PAYMENT.CAPTURE.DECLINED", taken!.paypalCaptureId),
      { now: NOW },
    );
    const reversed = await reconcileWebhookEvent(
      db,
      await delivered("PAYMENT.CAPTURE.REVERSED", taken!.paypalCaptureId),
      { now: NOW },
    );

    expect([declined.outcome, reversed.outcome]).toEqual(["flagged", "flagged"]);
    const [kept] = await db.select().from(capture).where(eq(capture.id, taken!.id));
    expect(kept!.status).toBe("completed");
  });

  it("never applies a simulator mock event (U1's decision 12)", async () => {
    const eventId = await delivered("PAYMENT.AUTHORIZATION.CREATED", authorizationId, {
      isMock: true,
    });

    const outcome = await reconcileWebhookEvent(db, eventId, { now: NOW });

    expect(outcome.outcome).toBe("flagged");
    const [stored] = await db.select().from(hold).where(eq(hold.id, version.id));
    expect(stored!.confirmedAt).toBeNull();
  });

  it("reconciles an event once: a second run finds it processed", async () => {
    const eventId = await delivered("PAYMENT.AUTHORIZATION.CREATED", authorizationId);

    await reconcileWebhookEvent(db, eventId, { now: NOW });
    const again = await reconcileWebhookEvent(db, eventId, { now: NOW });

    expect(again.outcome).toBe("processed_already");
    expect(
      (await eventsAbout(eventId)).filter((one) => one.action.startsWith("webhook.")),
    ).toHaveLength(1);
  });

  it("the hourly sweep reconciles what is pending and leaves what is still in its grace", async () => {
    // A clock before every other file's deliveries, so the sweep touches only these.
    const sweptAt = new Date("2026-10-01T10:00:00Z");
    const old = await delivered("PAYMENT.AUTHORIZATION.CREATED", authorizationId, {
      receivedAt: new Date(sweptAt.getTime() - 60 * 60 * 1000),
    });
    const fresh = await delivered("PAYMENT.CAPTURE.COMPLETED", "NOTYETOURS000001", {
      receivedAt: sweptAt,
    });

    const report = await reconcilePendingWebhooks(db, { now: sweptAt });

    expect(report.reconciled).toBeGreaterThanOrEqual(1);
    const [oldRow] = await db.select().from(webhookEvent).where(eq(webhookEvent.eventId, old));
    const [freshRow] = await db.select().from(webhookEvent).where(eq(webhookEvent.eventId, fresh));
    expect(oldRow!.processedAt).not.toBeNull();
    expect(freshRow!.processedAt).toBeNull();
  });
});
