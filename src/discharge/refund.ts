import { and, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";

import type { Executor } from "@/db/client";
import { capture, patientCase, refund } from "@/db/schema";
import type { MoneyDependencies } from "@/money/holds";
import { refundCaptured, type RefundView } from "@/money/refunds";
import { caseHolds } from "@/money/view";
import { PracticeError } from "@/practice/errors";

import { holdName, money } from "./wording";

/** A charge made at discharge that can still be refunded, in part or whole. */
export interface RefundableCapture {
  /** pawhold's id of the capture. */
  readonly captureId: string;
  /** The hold it was taken from: "the first hold", "the update's hold". */
  readonly holdName: string;
  readonly capturedPence: number;
  /** What is left of it to refund. */
  readonly leftPence: number;
}

/** The capture statuses a refund can be made from (U3's `refundCaptured`). */
const REFUNDABLE = ["completed", "partially_refunded"] as const;

/** The refund statuses that did not return money. */
const NOT_RETURNED = ["failed", "cancelled"] as const;

/**
 * The case's charges that can still be refunded, in the order their holds
 * were made, each with what is left of it.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The charges; none before discharge.
 */
export async function refundableCaptures(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<RefundableCapture[]> {
  const [own] = await executor
    .select({ id: patientCase.id })
    .from(patientCase)
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));
  if (!own) {
    return [];
  }
  const holds = (await caseHolds(executor, caseId)).filter((one) => one.authorisedAt !== null);
  if (holds.length === 0) {
    return [];
  }
  const captures = await executor
    .select()
    .from(capture)
    .where(
      and(
        inArray(
          capture.holdId,
          holds.map((one) => one.id),
        ),
        inArray(capture.status, [...REFUNDABLE]),
      ),
    );
  const returned =
    captures.length === 0
      ? []
      : await executor
          .select({ captureId: refund.captureId, amountPence: refund.amountPence })
          .from(refund)
          .where(
            and(
              inArray(
                refund.captureId,
                captures.map((one) => one.id),
              ),
              notInArray(refund.status, [...NOT_RETURNED]),
            ),
          );
  return holds.flatMap((one, at) =>
    captures
      .filter((taken) => taken.holdId === one.id)
      .sort((a, b) => a.sequence - b.sequence)
      .map((taken) => ({
        captureId: taken.id,
        holdName: holdName(at, holds.length),
        capturedPence: taken.amountPence,
        leftPence:
          taken.amountPence -
          returned
            .filter((each) => each.captureId === taken.id)
            .reduce((sum, each) => sum + each.amountPence, 0),
      }))
      .filter((taken) => taken.leftPence > 0),
  );
}

/**
 * Pounds and pence as a person types them ("25", "25.5", "£1,025.00") in
 * whole pence; null for anything else.
 *
 * @param text - What was typed.
 * @returns The pence, or null.
 */
export function parsePounds(text: string): number | null {
  const match = /^£?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const pounds = Number(match[1]!.replaceAll(",", ""));
  const pence = Number((match[2] ?? "0").padEnd(2, "0"));
  const total = pounds * 100 + pence;
  return Number.isSafeInteger(total) ? total : null;
}

const refundRequest = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  captureId: z.uuid(),
  /** The amount as typed, in pounds. */
  amount: z.string().max(30),
  /** Why, in the vet's words: the audit event's detail and the timeline's. */
  reason: z.string().max(500),
});

/**
 * "Refund" after discharge, on the case page: the amount typed in pounds and
 * the reason checked field by field, then U3's `refundCaptured` (written
 * before PayPal is asked, so a lost answer resumes with the same request id;
 * its reason on `capture.refund_requested`). The receipt shows it from U3's
 * `caseMoney`.
 *
 * @param deps - The database and the PayPal client.
 * @param request - The practice, the case, the charge, the amount typed and why.
 * @returns The refund.
 * @throws PracticeError `request_invalid` with each field's fault, or when the charge is not the case's to refund; MoneyError as `refundCaptured` refuses.
 */
export async function refundOnCase(
  deps: MoneyDependencies,
  request: z.input<typeof refundRequest>,
): Promise<RefundView> {
  const parsed = refundRequest.safeParse(request);
  if (!parsed.success) {
    throw new PracticeError("request_invalid", "That refund could not be read.");
  }
  const { practiceId, caseId, captureId, amount, reason } = parsed.data;
  const charges = await refundableCaptures(deps.db, practiceId, caseId);
  const charge = charges.find((one) => one.captureId === captureId);
  if (!charge) {
    throw new PracticeError(
      "request_invalid",
      "That charge is not this case's, or nothing is left of it to refund.",
    );
  }
  const currency = (await caseHolds(deps.db, caseId))[0]!.amount.currency;
  const fields: Record<string, string> = {};
  const pence = parsePounds(amount);
  if (pence === null) {
    fields.amount = "Enter an amount in pounds, as 25.00";
  } else if (pence === 0) {
    fields.amount = `Enter an amount above ${money(0, currency)}`;
  } else if (pence > charge.leftPence) {
    fields.amount = `At most ${money(charge.leftPence, currency)} is left to refund from this charge.`;
  }
  if (reason.trim() === "") {
    fields.reason = "Say why: it is kept on the case's timeline.";
  }
  if (Object.keys(fields).length > 0) {
    throw new PracticeError("request_invalid", "Check the fields marked below.", fields);
  }
  return refundCaptured(deps, {
    practiceId,
    caseId,
    captureId,
    amountPence: pence!,
    reason: reason.trim(),
    actor: "vet",
  });
}
