import { and, asc, eq, inArray } from "drizzle-orm";

import type { Executor } from "@/db/client";
import type { holdStatus, paymentKind } from "@/db/schema";
import { capture, hold, patientCase, refund } from "@/db/schema";
import { type CurrencyCode, currencyCode, type Money } from "@/money/currency";

import { MoneyError } from "./errors";
import type { MoneyState } from "./state";

/** A capture status that took the owner's money (pending ones may still complete). */
export const TAKEN_CAPTURE = ["completed", "pending", "partially_refunded", "refunded"] as const;

/** A refund status that returned, or is returning, the owner's money. */
export const RETURNED_REFUND = ["requested", "pending", "completed"] as const;

/** A hold as the screens and the job read it. */
export interface HoldView {
  /** The hold's id, which is its version's. */
  readonly id: string;
  readonly caseId: string;
  readonly versionNumber: number;
  readonly status: (typeof holdStatus.enumValues)[number];
  /** What it holds: the version's top less what was held before it (D3). */
  readonly amount: Money;
  readonly heldBeforePence: number;
  readonly paypalOrderId: string;
  readonly authorizationId: string | null;
  readonly originalAuthorizationId: string | null;
  readonly paymentKind: (typeof paymentKind.enumValues)[number] | null;
  readonly authorisedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly reauthorisedAt: Date | null;
  readonly reauthoriseRefusedAt: Date | null;
  readonly honourPeriodFlaggedAt: Date | null;
  /** When PayPal's webhook confirmed the authorisation ("Confirmed by PayPal"). */
  readonly confirmedAt: Date | null;
  readonly closedAt: Date | null;
  /** What its captures took. */
  readonly capturedPence: number;
  /**
   * What it released to the owner: once closed, its amount less its captures
   * (computed, since PayPal's voided authorisation keeps its original amount).
   */
  readonly releasedPence: number;
}

/** A case's money, as the screens read it. */
export interface CaseMoney {
  readonly caseId: string;
  readonly state: MoneyState;
  readonly currency: CurrencyCode;
  /** The holds in the order they were made. */
  readonly holds: readonly HoldView[];
  /** What is held now: the open holds' amounts. */
  readonly heldPence: number;
  readonly capturedPence: number;
  readonly releasedPence: number;
  readonly refundedPence: number;
}

type HoldRow = typeof hold.$inferSelect;

/**
 * A hold's row as its view.
 *
 * @param row - The row.
 * @param capturedPence - What its captures took.
 * @returns The view.
 */
export function holdView(row: HoldRow, capturedPence: number): HoldView {
  const closedByMoney =
    row.status === "captured" || row.status === "voided" || row.status === "expired";
  return {
    id: row.id,
    caseId: row.caseId,
    versionNumber: row.versionNumber,
    status: row.status,
    amount: { pence: row.amountPence, currency: currencyCode.parse(row.currencyCode) },
    heldBeforePence: row.heldBeforePence,
    paypalOrderId: row.paypalOrderId,
    authorizationId: row.authorizationId,
    originalAuthorizationId: row.originalAuthorizationId,
    paymentKind: row.paymentKind,
    authorisedAt: row.authorisedAt,
    expiresAt: row.expiresAt,
    reauthorisedAt: row.reauthorisedAt,
    reauthoriseRefusedAt: row.reauthoriseRefusedAt,
    honourPeriodFlaggedAt: row.honourPeriodFlaggedAt,
    confirmedAt: row.confirmedAt,
    closedAt: row.closedAt,
    capturedPence,
    releasedPence: closedByMoney ? row.amountPence - capturedPence : 0,
  };
}

/**
 * A case's holds, in the order they were made, with what each has captured.
 *
 * @param executor - The pool or an open transaction.
 * @param caseId - The case.
 * @returns The holds.
 */
export async function caseHolds(executor: Executor, caseId: string): Promise<HoldView[]> {
  const rows = await executor
    .select()
    .from(hold)
    .where(eq(hold.caseId, caseId))
    .orderBy(asc(hold.versionNumber));
  if (rows.length === 0) {
    return [];
  }
  const taken = await executor
    .select({ holdId: capture.holdId, amountPence: capture.amountPence })
    .from(capture)
    .where(
      and(
        inArray(
          capture.holdId,
          rows.map((row) => row.id),
        ),
        inArray(capture.status, [...TAKEN_CAPTURE]),
      ),
    );
  const capturedBy = new Map<string, number>();
  for (const one of taken) {
    capturedBy.set(one.holdId, (capturedBy.get(one.holdId) ?? 0) + one.amountPence);
  }
  return rows.map((row) => holdView(row, capturedBy.get(row.id) ?? 0));
}

/**
 * What the case's open holds hold: the base an update's increase is measured
 * from (U2's "the increase over the held total, which U3 computes from its
 * holds").
 *
 * @param executor - The pool or an open transaction.
 * @param caseId - The case.
 * @returns The pence held.
 */
export async function heldTotal(executor: Executor, caseId: string): Promise<number> {
  const rows = await executor
    .select({ amountPence: hold.amountPence })
    .from(hold)
    .where(and(eq(hold.caseId, caseId), eq(hold.status, "authorised")));
  return rows.reduce((sum, row) => sum + row.amountPence, 0);
}

/**
 * A practice's case's money: its state, its holds and what was held,
 * captured, released and refunded.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The case's money.
 * @throws MoneyError when the practice has no such case.
 */
export async function caseMoney(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<CaseMoney> {
  const [kase] = await executor
    .select({ state: patientCase.moneyState, currencyCode: patientCase.currencyCode })
    .from(patientCase)
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));
  if (!kase) {
    throw new MoneyError("case_not_found", `the practice has no case ${caseId}`);
  }
  const holds = await caseHolds(executor, caseId);
  const returned =
    holds.length === 0
      ? []
      : await executor
          .select({ amountPence: refund.amountPence })
          .from(refund)
          .innerJoin(capture, eq(capture.id, refund.captureId))
          .where(
            and(
              inArray(
                capture.holdId,
                holds.map((one) => one.id),
              ),
              inArray(refund.status, [...RETURNED_REFUND]),
            ),
          );
  return {
    caseId,
    state: kase.state,
    currency: currencyCode.parse(kase.currencyCode),
    holds,
    heldPence: holds
      .filter((one) => one.status === "authorised")
      .reduce((sum, one) => sum + one.amount.pence, 0),
    capturedPence: holds.reduce((sum, one) => sum + one.capturedPence, 0),
    releasedPence: holds.reduce((sum, one) => sum + one.releasedPence, 0),
    refundedPence: returned.reduce((sum, one) => sum + one.amountPence, 0),
  };
}
