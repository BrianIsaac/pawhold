import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Database, Transaction } from "@/db/client";
import { capture, hold, refund, webhookEvent } from "@/db/schema";

/**
 * How long a webhook that does not match the case's state is given before it
 * is flagged: PayPal can deliver before pawhold has committed the API answer
 * the event confirms (P9 saw PayPal's own pages lag 20 s; P8 is owed).
 */
export const RECONCILE_GRACE_MS = 15 * 60 * 1000;

/** What reconciling one stored webhook event did. */
export type ReconcileOutcome =
  | { readonly outcome: "reconciled"; readonly applied?: string }
  | { readonly outcome: "flagged"; readonly reason: string }
  | { readonly outcome: "pending"; readonly reason: string }
  | { readonly outcome: "processed_already" }
  | { readonly outcome: "not_found" };

/** The clock and the grace a reconciliation runs with. */
export interface ReconcileOptions {
  readonly now?: Date;
  readonly graceMs?: number;
}

type WebhookRow = typeof webhookEvent.$inferSelect;

/** What an event matched in pawhold's records. */
interface Match {
  readonly practiceId: string;
  readonly caseId: string;
  readonly holdId: string;
  readonly paypal: {
    readonly orderId?: string;
    readonly authorizationId?: string;
    readonly captureId?: string;
    readonly refundId?: string;
  };
}

/** The judgement of one event against the case's state. */
type Judgement =
  | {
      readonly kind: "expected";
      readonly match: Match;
      /** A change the state expects: a pending capture or refund completing. */
      readonly apply?: { readonly text: string; readonly run: (tx: Transaction) => Promise<void> };
      readonly confirm: (tx: Transaction, at: Date) => Promise<void>;
    }
  | {
      readonly kind: "unexpected";
      readonly match: Match | null;
      readonly reason: string;
      /** Whether waiting cannot help: the event contradicts what is recorded, or is never applied. */
      readonly final: boolean;
    };

const relatedOrder = z.object({
  resource: z
    .object({
      supplementary_data: z
        .object({ related_ids: z.object({ order_id: z.string().optional() }).optional() })
        .optional(),
    })
    .optional(),
});

/**
 * Reconciles one stored webhook event against the case's state (plan 3.2,
 * rule 5): the state changed on PayPal's answer to the call, and the webhook
 * confirms it. An event the state expects is reconciled (`webhook.reconciled`):
 * the hold, capture or refund it names is marked confirmed, and a pending
 * capture or refund it completes is completed. An event for a state the case
 * is not in is recorded and flagged (`webhook.flagged`), never applied: after
 * the grace period when the API answer may still be on its way, at once when
 * it contradicts what is recorded. A simulator mock event is never applied.
 * Each event is reconciled once, in one transaction with its audit event.
 *
 * @param db - The pool.
 * @param eventId - PayPal's event id, as U1's listener stored it.
 * @param options - The clock and the grace.
 * @returns What it did.
 */
export async function reconcileWebhookEvent(
  db: Database["db"],
  eventId: string,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? RECONCILE_GRACE_MS;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(webhookEvent)
      .where(eq(webhookEvent.eventId, eventId))
      .for("update");
    if (!row) {
      return { outcome: "not_found" } as const;
    }
    if (row.processedAt) {
      return { outcome: "processed_already" } as const;
    }
    const judgement = await judge(tx, row);
    if (
      judgement.kind === "unexpected" &&
      !judgement.final &&
      now.getTime() - row.receivedAt.getTime() < graceMs
    ) {
      return { outcome: "pending", reason: judgement.reason } as const;
    }

    if (judgement.kind === "expected") {
      await judgement.apply?.run(tx);
      await judgement.confirm(tx, now);
    }
    await tx
      .update(webhookEvent)
      .set({ processedAt: now })
      .where(eq(webhookEvent.eventId, row.eventId));
    const match = judgement.match;
    await appendAuditEvent(tx, {
      ...(match ? { practiceId: match.practiceId, caseId: match.caseId } : {}),
      actor: "paypal_webhook",
      action: judgement.kind === "expected" ? "webhook.reconciled" : "webhook.flagged",
      paypal: Object.fromEntries(
        Object.entries(match?.paypal ?? {}).filter(([, value]) => typeof value === "string"),
      ),
      webhook: { eventId: row.eventId, verified: true },
      detail: {
        eventType: row.eventType,
        resourceId: row.resourceId,
        holdId: match?.holdId ?? null,
        ...(judgement.kind === "expected"
          ? { applied: judgement.apply?.text ?? null }
          : { reason: judgement.reason }),
      },
    });
    return judgement.kind === "expected"
      ? ({
          outcome: "reconciled",
          ...(judgement.apply ? { applied: judgement.apply.text } : {}),
        } as const)
      : ({ outcome: "flagged", reason: judgement.reason } as const);
  });
}

/** What one sweep of the stored webhooks did. */
export interface ReconcileReport {
  readonly reconciled: number;
  readonly flagged: number;
  readonly pending: number;
  /** Events whose reconciliation failed this sweep: left for the next. */
  readonly failed: number;
}

/**
 * Reconciles every stored webhook event received by now and not yet
 * processed, oldest first: the hourly job's catch-up for events whose
 * reconciliation at receipt failed or waited out its grace. One event's
 * failure is counted and the sweep goes on.
 *
 * @param db - The pool.
 * @param options - The clock, the grace and how many to take.
 * @param options.limit - The most events one sweep takes.
 * @returns How many were reconciled, flagged, and left pending.
 */
export async function reconcilePendingWebhooks(
  db: Database["db"],
  options: ReconcileOptions & { readonly limit?: number } = {},
): Promise<ReconcileReport> {
  const now = options.now ?? new Date();
  const waiting = await db
    .select({ eventId: webhookEvent.eventId })
    .from(webhookEvent)
    .where(and(isNull(webhookEvent.processedAt), lte(webhookEvent.receivedAt, now)))
    .orderBy(asc(webhookEvent.receivedAt))
    .limit(options.limit ?? 500);
  const report = { reconciled: 0, flagged: 0, pending: 0, failed: 0 };
  for (const { eventId } of waiting) {
    try {
      const done = await reconcileWebhookEvent(db, eventId, { ...options, now });
      if (
        done.outcome === "reconciled" ||
        done.outcome === "flagged" ||
        done.outcome === "pending"
      ) {
        report[done.outcome] += 1;
      }
    } catch (error) {
      console.error("pawhold: a webhook could not be reconciled", {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      report.failed += 1;
    }
  }
  return report;
}

/**
 * Judges an event against what pawhold recorded of the resource it names.
 *
 * @param tx - The open transaction.
 * @param row - The stored event.
 * @returns The judgement.
 */
async function judge(tx: Transaction, row: WebhookRow): Promise<Judgement> {
  if (row.isMock) {
    return {
      kind: "unexpected",
      match: null,
      reason: "a simulator mock event: recorded, never applied",
      final: true,
    };
  }
  const id = row.resourceId;
  if (!id) {
    return { kind: "unexpected", match: null, reason: "the event names no resource", final: true };
  }
  switch (row.eventType) {
    case "PAYMENT.AUTHORIZATION.CREATED":
      return authorisationCreated(tx, row, id);
    case "PAYMENT.AUTHORIZATION.VOIDED":
      return authorisationVoided(tx, id);
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.PENDING":
    case "PAYMENT.CAPTURE.DECLINED":
    case "PAYMENT.CAPTURE.REVERSED":
      return captureEvent(tx, row.eventType, id);
    case "PAYMENT.CAPTURE.REFUNDED":
      return refundEvent(tx, id);
    case "CHECKOUT.ORDER.APPROVED":
      return orderApproved(tx, id);
    default:
      return {
        kind: "unexpected",
        match: null,
        reason: `${row.eventType} is not an event pawhold reconciles`,
        final: true,
      };
  }
}

/**
 * `PAYMENT.AUTHORIZATION.CREATED`: expected once the hold records the
 * authorisation (the original or the reauthorised one).
 *
 * @param tx - The open transaction.
 * @param row - The stored event.
 * @param authorizationId - The authorisation.
 * @returns The judgement.
 */
async function authorisationCreated(
  tx: Transaction,
  row: WebhookRow,
  authorizationId: string,
): Promise<Judgement> {
  const found = await holdByAuthorization(tx, authorizationId);
  if (found) {
    return {
      kind: "expected",
      match: holdMatch(found, { authorizationId }),
      confirm: async (inner, at) => {
        await inner
          .update(hold)
          .set({ confirmedAt: at, updatedAt: sql`now()` })
          .where(and(eq(hold.id, found.id), isNull(hold.confirmedAt)));
      },
    };
  }
  const parsed = relatedOrder.safeParse(row.payload);
  const orderId = parsed.success
    ? parsed.data.resource?.supplementary_data?.related_ids?.order_id
    : undefined;
  const ordered = orderId ? await holdByOrder(tx, orderId) : null;
  return {
    kind: "unexpected",
    match: ordered ? holdMatch(ordered, { orderId: ordered.paypalOrderId, authorizationId }) : null,
    reason: ordered
      ? `PayPal authorised order ${ordered.paypalOrderId}, whose hold pawhold records as ${ordered.status}`
      : `no hold has authorisation ${authorizationId}`,
    final: false,
  };
}

/**
 * `PAYMENT.AUTHORIZATION.VOIDED`: expected once pawhold closed the hold (a
 * void, a final capture whose rest PayPal released, or an expiry); a void of
 * a hold pawhold holds open is flagged.
 *
 * @param tx - The open transaction.
 * @param authorizationId - The authorisation.
 * @returns The judgement.
 */
async function authorisationVoided(tx: Transaction, authorizationId: string): Promise<Judgement> {
  const found = await holdByAuthorization(tx, authorizationId);
  if (!found) {
    return {
      kind: "unexpected",
      match: null,
      reason: `no hold has authorisation ${authorizationId}`,
      final: false,
    };
  }
  const match = holdMatch(found, { authorizationId });
  if (found.status === "voided" || found.status === "captured" || found.status === "expired") {
    return { kind: "expected", match, confirm: async () => {} };
  }
  return {
    kind: "unexpected",
    match,
    reason: `PayPal voided authorisation ${authorizationId}, which pawhold holds open (${found.status})`,
    final: false,
  };
}

/**
 * A capture's events: `COMPLETED` confirms a completed capture or completes
 * a pending one; `PENDING` confirms a pending one; `DECLINED` and `REVERSED`
 * contradict the money pawhold counts as taken, and are flagged at once.
 *
 * @param tx - The open transaction.
 * @param eventType - The event's type.
 * @param captureId - PayPal's capture id.
 * @returns The judgement.
 */
async function captureEvent(
  tx: Transaction,
  eventType: string,
  captureId: string,
): Promise<Judgement> {
  const [found] = await tx
    .select({
      id: capture.id,
      status: capture.status,
      hold: hold,
    })
    .from(capture)
    .innerJoin(hold, eq(hold.id, capture.holdId))
    .where(eq(capture.paypalCaptureId, captureId));
  if (!found) {
    return {
      kind: "unexpected",
      match: null,
      reason: `no capture has id ${captureId}`,
      final: false,
    };
  }
  const match = holdMatch(found.hold, { captureId });
  const confirm = async (inner: Transaction, at: Date) => {
    await inner
      .update(capture)
      .set({ confirmedAt: at, updatedAt: sql`now()` })
      .where(and(eq(capture.id, found.id), isNull(capture.confirmedAt)));
  };
  const taken =
    found.status === "completed" ||
    found.status === "partially_refunded" ||
    found.status === "refunded";
  if (eventType === "PAYMENT.CAPTURE.COMPLETED" && taken) {
    return { kind: "expected", match, confirm };
  }
  if (eventType === "PAYMENT.CAPTURE.COMPLETED" && found.status === "pending") {
    return {
      kind: "expected",
      match,
      confirm,
      apply: {
        text: "capture completed",
        run: async (inner) => {
          await inner
            .update(capture)
            .set({ status: "completed", updatedAt: sql`now()` })
            .where(eq(capture.id, found.id));
        },
      },
    };
  }
  if (eventType === "PAYMENT.CAPTURE.PENDING" && (found.status === "pending" || taken)) {
    // A late PENDING for a capture since completed: PayPal does not promise order.
    return { kind: "expected", match, confirm: async () => {} };
  }
  if (
    eventType === "PAYMENT.CAPTURE.DECLINED" &&
    (found.status === "declined" || found.status === "failed")
  ) {
    return { kind: "expected", match, confirm: async () => {} };
  }
  const contradiction =
    eventType === "PAYMENT.CAPTURE.DECLINED" || eventType === "PAYMENT.CAPTURE.REVERSED"
      ? `PayPal says capture ${captureId} was ${eventType === "PAYMENT.CAPTURE.DECLINED" ? "declined" : "reversed"}: the money was not kept, and the practice must act`
      : `PayPal says capture ${captureId} is ${eventType.split(".").at(-1)!.toLowerCase()}; pawhold records it ${found.status}`;
  return { kind: "unexpected", match, reason: contradiction, final: true };
}

/**
 * `PAYMENT.CAPTURE.REFUNDED`, whose resource is the refund: confirms a
 * completed refund or completes a pending one.
 *
 * @param tx - The open transaction.
 * @param refundId - PayPal's refund id.
 * @returns The judgement.
 */
async function refundEvent(tx: Transaction, refundId: string): Promise<Judgement> {
  const [found] = await tx
    .select({
      id: refund.id,
      status: refund.status,
      hold: hold,
      paypalCaptureId: capture.paypalCaptureId,
    })
    .from(refund)
    .innerJoin(capture, eq(capture.id, refund.captureId))
    .innerJoin(hold, eq(hold.id, capture.holdId))
    .where(eq(refund.paypalRefundId, refundId));
  if (!found) {
    return {
      kind: "unexpected",
      match: null,
      reason: `no refund has id ${refundId}`,
      final: false,
    };
  }
  const match = holdMatch(found.hold, { captureId: found.paypalCaptureId, refundId });
  const confirm = async (inner: Transaction, at: Date) => {
    await inner
      .update(refund)
      .set({ confirmedAt: at, updatedAt: sql`now()` })
      .where(and(eq(refund.id, found.id), isNull(refund.confirmedAt)));
  };
  if (found.status === "completed") {
    return { kind: "expected", match, confirm };
  }
  if (found.status === "pending") {
    return {
      kind: "expected",
      match,
      confirm,
      apply: {
        text: "refund completed",
        run: async (inner) => {
          await inner
            .update(refund)
            .set({ status: "completed", updatedAt: sql`now()` })
            .where(eq(refund.id, found.id));
        },
      },
    };
  }
  return {
    kind: "unexpected",
    match,
    reason: `PayPal says refund ${refundId} completed; pawhold records it ${found.status}`,
    final: true,
  };
}

/**
 * `CHECKOUT.ORDER.APPROVED`: the owner approved a hold's order on PayPal's
 * page; nothing is held until the authorise call. Expected while the hold is
 * ordered or later; flagged when its estimate was withdrawn or the update
 * declined.
 *
 * @param tx - The open transaction.
 * @param orderId - The order.
 * @returns The judgement.
 */
async function orderApproved(tx: Transaction, orderId: string): Promise<Judgement> {
  const found = await holdByOrder(tx, orderId);
  if (!found) {
    return {
      kind: "unexpected",
      match: null,
      reason: `no hold has order ${orderId}`,
      final: false,
    };
  }
  if (found.status === "withdrawn" || found.status === "declined") {
    return {
      kind: "unexpected",
      match: holdMatch(found, { orderId }),
      reason: `the owner approved order ${orderId}, whose hold is ${found.status}: nothing is held unless it is authorised`,
      final: true,
    };
  }
  return { kind: "expected", match: holdMatch(found, { orderId }), confirm: async () => {} };
}

/**
 * The hold an authorisation belongs to, as the original or the reauthorised one.
 *
 * @param tx - The open transaction.
 * @param authorizationId - The authorisation.
 * @returns The hold, or null.
 */
async function holdByAuthorization(
  tx: Transaction,
  authorizationId: string,
): Promise<typeof hold.$inferSelect | null> {
  const [found] = await tx
    .select()
    .from(hold)
    .where(
      or(
        eq(hold.authorizationId, authorizationId),
        eq(hold.originalAuthorizationId, authorizationId),
      ),
    );
  return found ?? null;
}

/**
 * The hold an order belongs to.
 *
 * @param tx - The open transaction.
 * @param orderId - The order.
 * @returns The hold, or null.
 */
async function holdByOrder(
  tx: Transaction,
  orderId: string,
): Promise<typeof hold.$inferSelect | null> {
  const [found] = await tx.select().from(hold).where(eq(hold.paypalOrderId, orderId));
  return found ?? null;
}

/**
 * What an event matched, for its audit event.
 *
 * @param found - The hold.
 * @param ids - The PayPal ids the event named.
 * @returns The match.
 */
function holdMatch(found: typeof hold.$inferSelect, ids: Match["paypal"]): Match {
  return {
    practiceId: found.practiceId,
    caseId: found.caseId,
    holdId: found.id,
    paypal: { orderId: found.paypalOrderId, ...ids },
  };
}
