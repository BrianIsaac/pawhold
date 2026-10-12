import { and, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import { auditActor, capture, hold, refund } from "@/db/schema";
import { type CurrencyCode, currencyCode } from "@/money/currency";
import { parsePayPalTime, refundCapture, type Refund } from "@/paypal/payments";

import { askPayPal, MoneyError } from "./errors";
import { asking, holdRequestId, type MoneyDependencies, parse, refusedEvent } from "./holds";
import { lockCase, moveCase, nextState } from "./state";

const refundRequest = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  /** pawhold's id of the capture to refund. */
  captureId: z.uuid(),
  /** The part to refund; what is left of the capture when absent. */
  amountPence: z.int().min(1).optional(),
  /** Why: "goodwill or correction" (plan 3.2), in the vet's words. */
  reason: z.string().trim().min(1).max(500),
  actor: z.enum(auditActor.enumValues),
});

/** A refund, as the screens and the receipt read it. */
export interface RefundView {
  readonly id: string;
  readonly captureId: string;
  readonly paypalCaptureId: string;
  readonly holdId: string;
  readonly sequence: number;
  readonly amountPence: number;
  readonly currency: CurrencyCode;
  readonly status: (typeof refund.status.enumValues)[number];
  readonly paypalRefundId: string | null;
  readonly reason: string;
}

/** The statuses of a refund that returned, or is returning, money. */
const NOT_RETURNED = ["failed", "cancelled"] as const;

/**
 * Refunds a capture, in part or whole, after discharge (plan 3.2: captured
 * --goodwill or correction--> refunded). The refund is written before PayPal
 * is asked (`capture.refund_requested`), so a refund whose answer was lost is
 * resumed with the same amount under the same `PayPal-Request-Id`; PayPal's
 * answer moves the case to refunded with `capture.refunded`. A capture's
 * refunds never sum above it (the code, and the database at commit).
 *
 * @param deps - The database and the PayPal client.
 * @param request - The practice, the case, the capture, the amount, why, and who.
 * @returns The refund.
 * @throws MoneyError when the case was not discharged, there is no such capture, the amount is above what is left of it, or PayPal refuses.
 */
export async function refundCaptured(
  deps: MoneyDependencies,
  request: z.input<typeof refundRequest>,
): Promise<RefundView> {
  const {
    practiceId,
    caseId,
    captureId,
    amountPence,
    reason,
    actor: by,
  } = parse(refundRequest, request);
  const asked = await deps.db.transaction(async (tx) => {
    const kase = await lockCase(tx, practiceId, caseId);
    nextState("refund", kase.moneyState);
    const [taken] = await tx
      .select({
        id: capture.id,
        holdId: capture.holdId,
        sequence: capture.sequence,
        paypalCaptureId: capture.paypalCaptureId,
        amountPence: capture.amountPence,
        currencyCode: capture.currencyCode,
        status: capture.status,
        paypalOrderId: hold.paypalOrderId,
        authorizationId: capture.authorizationId,
      })
      .from(capture)
      .innerJoin(hold, eq(hold.id, capture.holdId))
      .where(and(eq(capture.id, captureId), eq(hold.caseId, caseId)))
      .for("update", { of: capture });
    if (!taken) {
      throw new MoneyError("capture_not_found", `the case has no capture ${captureId}`);
    }
    if (taken.status !== "completed" && taken.status !== "partially_refunded") {
      throw new MoneyError(
        "refund_refused",
        `capture ${taken.paypalCaptureId} is ${taken.status.replaceAll("_", " ")}: only a completed capture is refunded`,
      );
    }
    const refunds = await tx.select().from(refund).where(eq(refund.captureId, taken.id));
    const pending = refunds.find((one) => one.status === "requested");
    if (pending) {
      if (amountPence !== undefined && amountPence !== pending.amountPence) {
        throw new MoneyError(
          "refund_refused",
          `a refund of ${pending.amountPence} pence is still being asked of PayPal: ask it again first`,
        );
      }
      return { taken, row: pending };
    }
    const returned = refunds
      .filter((one) => !(NOT_RETURNED as readonly string[]).includes(one.status))
      .reduce((sum, one) => sum + one.amountPence, 0);
    const left = taken.amountPence - returned;
    const pence = amountPence ?? left;
    if (pence <= 0 || pence > left) {
      throw new MoneyError(
        "refund_refused",
        `${left} pence of capture ${taken.paypalCaptureId} is left to refund; ${pence} pence asked`,
      );
    }
    const [row] = await tx
      .insert(refund)
      .values({
        captureId: taken.id,
        sequence: refunds.length + 1,
        amountPence: pence,
        currencyCode: taken.currencyCode,
        reason,
        requestedBy: by,
      })
      .returning();
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: by,
      action: "capture.refund_requested",
      amount: { pence, currency: currencyCode.parse(taken.currencyCode) },
      paypal: {
        orderId: taken.paypalOrderId,
        authorizationId: taken.authorizationId,
        captureId: taken.paypalCaptureId,
      },
      detail: { refundId: row!.id, captureId: taken.id, reason, leftBeforePence: left },
    });
    return { taken, row: row! };
  });

  const { taken, row } = asked;
  const currency = currencyCode.parse(taken.currencyCode);
  let answer: Refund;
  try {
    answer = await asking(
      deps.db,
      refusedEvent({ id: caseId, practiceId }, by, "capture.refund_refused", {
        orderId: taken.paypalOrderId,
        authorizationId: taken.authorizationId,
        captureId: taken.paypalCaptureId,
      }),
      () =>
        askPayPal("refund the capture", () =>
          refundCapture(
            deps.paypal,
            taken.paypalCaptureId,
            holdRequestId(caseId, taken.holdId, `refund.${taken.sequence}.${row.sequence}`),
            { pence: row.amountPence, currency },
          ),
        ),
    );
  } catch (error) {
    if (error instanceof MoneyError && error.reason === "paypal_refused") {
      await deps.db
        .update(refund)
        .set({ status: "failed", updatedAt: sql`now()` })
        .where(and(eq(refund.id, row.id), eq(refund.status, "requested")));
    }
    throw error;
  }

  const status = answer.status.toLowerCase() as Lowercase<Refund["status"]>;
  const stored = await deps.db.transaction(async (tx) => {
    const kase = await lockCase(tx, practiceId, caseId);
    const [updated] = await tx
      .update(refund)
      .set({
        status,
        paypalRefundId: answer.id,
        refundedAt: answer.create_time ? parsePayPalTime(answer.create_time) : null,
        updatedAt: sql`now()`,
      })
      .where(eq(refund.id, row.id))
      .returning();
    const returnedRows = await tx
      .select({ amountPence: refund.amountPence })
      .from(refund)
      .where(and(eq(refund.captureId, taken.id), notInArray(refund.status, [...NOT_RETURNED])));
    const returned = returnedRows.reduce((sum, one) => sum + one.amountPence, 0);
    const succeeded = status === "completed" || status === "pending";
    if (succeeded) {
      await tx
        .update(capture)
        .set({
          status: returned >= taken.amountPence ? "refunded" : "partially_refunded",
          updatedAt: sql`now()`,
        })
        .where(eq(capture.id, taken.id));
    }
    const to = succeeded ? nextState("refund", kase.moneyState)! : kase.moneyState;
    await moveCase(tx, caseId, to);
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: by,
      action: succeeded ? "capture.refunded" : "capture.refund_failed",
      moneyStateBefore: kase.moneyState,
      moneyStateAfter: to,
      amount: { pence: row.amountPence, currency },
      paypal: {
        orderId: taken.paypalOrderId,
        authorizationId: taken.authorizationId,
        captureId: taken.paypalCaptureId,
        refundId: answer.id,
      },
      detail: { refundId: row.id, refundStatus: answer.status, reason: row.reason },
    });
    return updated!;
  });
  if (stored.status === "failed" || stored.status === "cancelled") {
    throw new MoneyError("paypal_refused", `PayPal answered the refund ${answer.status}`);
  }
  return {
    id: stored.id,
    captureId: taken.id,
    paypalCaptureId: taken.paypalCaptureId,
    holdId: taken.holdId,
    sequence: stored.sequence,
    amountPence: stored.amountPence,
    currency,
    status: stored.status,
    paypalRefundId: stored.paypalRefundId,
    reason: stored.reason,
  };
}
