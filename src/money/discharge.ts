import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Executor, Transaction } from "@/db/client";
import { allocation, auditActor, bill, billLine, capture, hold } from "@/db/schema";
import { type EstimateVersionView, loadEstimateVersion } from "@/estimate/version";
import type { CurrencyCode } from "@/money/currency";
import type { captureStatus as paypalCaptureStatus } from "@/paypal/payments";
import {
  captureAuthorization,
  type Capture,
  moneyFromPayPal,
  parsePayPalTime,
  pence,
  voidAuthorization,
} from "@/paypal/payments";

import { allocateBill, approvalsByHold, type AllocatableHold } from "./allocation";
import { askPayPal, MoneyError } from "./errors";
import { asking, holdRequestId, type MoneyDependencies, parse, refusedEvent } from "./holds";
import { type LockedCase, lockCase, type MoneyState, moveCase, nextState } from "./state";
import { caseHolds, caseMoney, type HoldView } from "./view";

/** The wording a line off the approved estimate is refused with (plan 6, discharge). */
export const NOT_ON_ESTIMATE = "Not on an approved estimate. Send an update to charge it.";

const actor = z.enum(auditActor.enumValues);

const billLineInput = z.strictObject({
  estimateLineId: z.uuid(),
  quantity: z.int().min(1).max(1_000),
});

export type BillLineInput = z.input<typeof billLineInput>;

const planRequest = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  lines: z.array(billLineInput).max(200),
});

const signOffRequest = planRequest.extend({ actor });

const caseRequest = z.strictObject({ practiceId: z.uuid(), caseId: z.uuid() });

/** One bill line as planned: the estimate line it fulfils and the holds that pay it. */
export interface PlannedBillLine {
  readonly estimateLineId: string;
  readonly code: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPricePence: number;
  readonly amountPence: number;
  readonly parts: readonly { readonly holdId: string; readonly amountPence: number }[];
}

/** One hold as discharge will close it. */
export interface PlannedHold {
  readonly holdId: string;
  readonly versionNumber: number;
  readonly amountPence: number;
  /** What its final capture takes; 0 when it is voided. */
  readonly capturePence: number;
  /** What it releases to the owner (its amount less its capture). */
  readonly releasePence: number;
  /** How it closes: by a final capture (any rest released by PayPal), or a void. */
  readonly closeBy: "final_capture" | "void";
}

/** A bill allocated to the case's holds: U7's "{a} from the first hold, {b} from the update's hold". */
export interface DischargePlan {
  readonly currency: CurrencyCode;
  readonly lines: readonly PlannedBillLine[];
  readonly holds: readonly PlannedHold[];
  readonly billedPence: number;
  readonly heldPence: number;
  readonly releasedPence: number;
}

/** What a discharge did. */
export interface DischargeResult {
  readonly state: MoneyState;
  readonly billedPence: number;
  readonly capturedPence: number;
  readonly releasedPence: number;
  /** The bill's share on holds PayPal could no longer capture (expired). */
  readonly unpaidPence: number;
  readonly holds: readonly HoldView[];
}

/**
 * Plans a bill against the case's holds without writing anything: each line
 * checked against the latest approved estimate and allocated to holds (rules
 * 1 and 2), and each hold's capture and release. What the vet sees before
 * confirming.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the case and the lines done.
 * @returns The plan.
 * @throws MoneyError when a line is not on the approved estimate, a quantity is above the one approved, or the case holds nothing.
 */
export async function planDischarge(
  executor: Executor,
  request: z.input<typeof planRequest>,
): Promise<DischargePlan> {
  const { practiceId, caseId, lines } = parse(planRequest, request);
  return executor.transaction(async (tx) => {
    const kase = await lockCase(tx, practiceId, caseId);
    return planBill(tx, kase, lines);
  });
}

/**
 * The vet signs the itemised bill off (plan 3.3): the bill, its lines and
 * their allocation to holds are written once and kept as signed, with
 * `bill.signed_off`. Nothing is captured that is not on such a bill (rule
 * 6), and nothing before it (D17).
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the case, who signs it off and the lines done.
 * @returns The plan as signed off.
 * @throws MoneyError when the case is not held, is signed off already, or a line is refused.
 */
export async function signOffBill(
  executor: Executor,
  request: z.input<typeof signOffRequest>,
): Promise<DischargePlan> {
  const { practiceId, caseId, lines, actor: by } = parse(signOffRequest, request);
  return executor.transaction(async (tx) => {
    const kase = await lockCase(tx, practiceId, caseId);
    const stays = nextState("sign_off", kase.moneyState)!;
    const [signed] = await tx.select({ id: bill.id }).from(bill).where(eq(bill.caseId, caseId));
    if (signed) {
      throw new MoneyError("bill_refused", "the case's bill is signed off already");
    }
    const plan = await planBill(tx, kase, lines);
    const [made] = await tx
      .insert(bill)
      .values({
        practiceId,
        caseId,
        currencyCode: kase.currency,
        totalPence: plan.billedPence,
        signedOffBy: by,
      })
      .returning({ id: bill.id });
    if (plan.lines.length > 0) {
      const stored = await tx
        .insert(billLine)
        .values(
          plan.lines.map((line, at) => ({
            billId: made!.id,
            position: at + 1,
            estimateLineId: line.estimateLineId,
            quantity: line.quantity,
            unitPricePence: line.unitPricePence,
          })),
        )
        .returning({ id: billLine.id, position: billLine.position });
      const idAt = new Map(stored.map((row) => [row.position, row.id]));
      await tx.insert(allocation).values(
        plan.lines.flatMap((line, at) =>
          line.parts.map((part) => ({
            billLineId: idAt.get(at + 1)!,
            holdId: part.holdId,
            amountPence: part.amountPence,
          })),
        ),
      );
    }
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: by,
      action: "bill.signed_off",
      moneyStateBefore: kase.moneyState,
      moneyStateAfter: stays,
      amount: { pence: plan.billedPence, currency: kase.currency },
      detail: {
        billId: made!.id,
        lineCount: plan.lines.length,
        holds: plan.holds.map((one) => ({
          holdId: one.holdId,
          capturePence: one.capturePence,
          releasePence: one.releasePence,
          closeBy: one.closeBy,
        })),
        releasedPence: plan.releasedPence,
      },
    });
    return plan;
  });
}

/**
 * Signs the bill off and discharges the case on one confirm (U7): see
 * {@link signOffBill} and {@link dischargeCase}.
 *
 * @param deps - The database and the PayPal client.
 * @param request - The practice, the case, who signs it off and the lines done.
 * @returns What the discharge did.
 * @throws MoneyError as either step does; a discharge stopped part way resumes with {@link dischargeCase}.
 */
export async function discharge(
  deps: MoneyDependencies,
  request: z.input<typeof signOffRequest>,
): Promise<DischargeResult> {
  const { practiceId, caseId } = parse(signOffRequest, request);
  await signOffBill(deps.db, request);
  return dischargeCase(deps, { practiceId, caseId });
}

/**
 * Discharges a signed-off bill: captures each hold's share, final on each
 * (the last capture against a hold), in the order the holds were made; then
 * voids every hold that will not be captured again and is not fully captured
 * (rule 3). Each step changes the case on PayPal's answer in one transaction
 * with one audit event carrying the PayPal ids (`hold.captured`,
 * `hold.voided`); the case moves to captured once a capture lands, and to
 * released when its last hold closes with anything left over. Every step's
 * `PayPal-Request-Id` comes from the case, the hold and the step, so a
 * discharge stopped part way is resumed by calling this again, and a
 * capture whose answer was lost captures once. A hold PayPal says has expired
 * is recorded (`hold.expired`) and its share reported unpaid.
 *
 * @param deps - The database and the PayPal client.
 * @param request - The practice and the case.
 * @returns What the discharge did.
 * @throws MoneyError when there is no signed-off bill, or PayPal refuses a step or cannot be reached.
 */
export async function dischargeCase(
  deps: MoneyDependencies,
  request: z.input<typeof caseRequest>,
): Promise<DischargeResult> {
  const { practiceId, caseId } = parse(caseRequest, request);
  for (;;) {
    const next = await nextStep(deps.db, practiceId, caseId);
    if (!next) {
      break;
    }
    if (next.kind === "capture") {
      await captureStep(deps, practiceId, caseId, next);
    } else {
      await voidStep(deps, practiceId, caseId, next.hold);
    }
  }
  return dischargeResult(deps.db, practiceId, caseId);
}

/** The next step of a discharge. */
type Step =
  | {
      readonly kind: "capture";
      readonly hold: HoldView;
      readonly pence: number;
      readonly sequence: number;
    }
  | { readonly kind: "void"; readonly hold: HoldView };

/**
 * The discharge's next step: the first hold, in the order made, with a share
 * still to capture; else the first open hold with nothing more to capture.
 *
 * @param executor - The pool.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The step, or null when every hold is closed.
 * @throws MoneyError when the case has no signed-off bill.
 */
async function nextStep(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<Step | null> {
  const shares = await billShares(executor, practiceId, caseId);
  const holds = (await caseHolds(executor, caseId)).filter((one) => one.status === "authorised");
  for (const one of holds) {
    const left = (shares.get(one.id) ?? 0) - one.capturedPence;
    if (left > 0) {
      const [attempts] = await executor
        .select({ count: sql<number>`count(*)::int` })
        .from(capture)
        .where(eq(capture.holdId, one.id));
      return { kind: "capture", hold: one, pence: left, sequence: (attempts?.count ?? 0) + 1 };
    }
  }
  const open = holds[0];
  return open ? { kind: "void", hold: open } : null;
}

/**
 * Each hold's share of the signed-off bill.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns Pence by hold id.
 * @throws MoneyError when the case has no signed-off bill.
 */
async function billShares(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<Map<string, number>> {
  const [signed] = await executor
    .select({ id: bill.id })
    .from(bill)
    .where(and(eq(bill.caseId, caseId), eq(bill.practiceId, practiceId)));
  if (!signed) {
    throw new MoneyError(
      "bill_refused",
      "the case has no signed-off bill: nothing is captured that is not on one (rule 6), and nothing before discharge (D17)",
    );
  }
  const parts = await executor
    .select({ holdId: allocation.holdId, amountPence: allocation.amountPence })
    .from(allocation)
    .innerJoin(billLine, eq(billLine.id, allocation.billLineId))
    .where(eq(billLine.billId, signed.id));
  const shares = new Map<string, number>();
  for (const part of parts) {
    shares.set(part.holdId, (shares.get(part.holdId) ?? 0) + part.amountPence);
  }
  return shares;
}

/**
 * Captures a hold's share, final, and records PayPal's answer.
 *
 * @param deps - The database and the PayPal client.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @param step - The hold, the pence and the capture's ordinal.
 * @param step.hold - The hold.
 * @param step.pence - What to capture.
 * @param step.sequence - The capture's ordinal against the hold.
 * @returns Resolves once recorded.
 * @throws MoneyError when PayPal declines or refuses the capture (other than an expired hold) or cannot be reached.
 */
async function captureStep(
  deps: MoneyDependencies,
  practiceId: string,
  caseId: string,
  step: { hold: HoldView; pence: number; sequence: number },
): Promise<void> {
  const { hold: target } = step;
  let answer: Capture;
  try {
    answer = await asking(
      deps.db,
      refusedEvent({ id: caseId, practiceId }, "system", "hold.capture_refused", {
        orderId: target.paypalOrderId,
        authorizationId: target.authorizationId!,
      }),
      () =>
        askPayPal("capture the hold", () =>
          captureAuthorization(deps.paypal, target.authorizationId!, {
            amount: { pence: step.pence, currency: target.amount.currency },
            finalCapture: true,
            requestId: holdRequestId(caseId, target.id, `capture.${step.sequence}`),
          }),
        ),
    );
  } catch (error) {
    if (error instanceof MoneyError && error.issues.includes("AUTHORIZATION_EXPIRED")) {
      await recordExpired(deps, practiceId, caseId, target, error);
      return;
    }
    throw error;
  }

  const status = lowerStatus(answer.status);
  const taken = status !== "declined" && status !== "failed";
  await deps.db.transaction(async (tx) => {
    const kase = await lockCase(tx, practiceId, caseId);
    const amount = answer.amount ? moneyFromPayPal(answer.amount) : target.amount;
    await tx
      .insert(capture)
      .values({
        holdId: target.id,
        sequence: step.sequence,
        paypalCaptureId: answer.id,
        authorizationId: target.authorizationId!,
        amountPence: answer.amount ? amount.pence : step.pence,
        currencyCode: amount.currency,
        finalCapture: answer.final_capture ?? true,
        status,
        paypalFeePence: pence(answer.seller_receivable_breakdown?.paypal_fee),
        netPence: pence(answer.seller_receivable_breakdown?.net_amount),
        capturedAt: answer.create_time ? parsePayPalTime(answer.create_time) : new Date(),
      })
      .onConflictDoNothing({ target: capture.paypalCaptureId });
    if (taken) {
      await tx
        .update(hold)
        .set({ status: "captured", closedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(hold.id, target.id), eq(hold.status, "authorised")));
    }
    const to = await dischargedState(tx, kase);
    await moveCase(tx, caseId, to);
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: "system",
      action: taken ? "hold.captured" : "hold.capture_declined",
      moneyStateBefore: kase.moneyState,
      moneyStateAfter: to,
      amount: { pence: step.pence, currency: target.amount.currency },
      paypal: {
        orderId: target.paypalOrderId,
        authorizationId: target.authorizationId!,
        captureId: answer.id,
      },
      detail: {
        holdId: target.id,
        finalCapture: true,
        captureStatus: answer.status,
        releasedPence: taken ? target.amount.pence - target.capturedPence - step.pence : 0,
      },
    });
  });
  if (!taken) {
    throw new MoneyError(
      "paypal_refused",
      `PayPal answered the capture ${answer.status}: nothing was taken from hold ${target.id}`,
    );
  }
}

/**
 * Records a hold PayPal will no longer capture: closed as expired, its
 * share of the bill unpaid, with PayPal's `debug_id`.
 *
 * @param deps - The database.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @param target - The hold.
 * @param refusal - PayPal's refusal.
 * @returns Resolves once recorded.
 */
async function recordExpired(
  deps: MoneyDependencies,
  practiceId: string,
  caseId: string,
  target: HoldView,
  refusal: MoneyError,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const kase = await lockCase(tx, practiceId, caseId);
    await tx
      .update(hold)
      .set({ status: "expired", closedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(hold.id, target.id), eq(hold.status, "authorised")));
    const to = await dischargedState(tx, kase);
    await moveCase(tx, caseId, to);
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: "system",
      action: "hold.expired",
      moneyStateBefore: kase.moneyState,
      moneyStateAfter: to,
      amount: target.amount,
      paypal: {
        orderId: target.paypalOrderId,
        authorizationId: target.authorizationId!,
        ...(refusal.debugId ? { debugId: refusal.debugId } : {}),
      },
      detail: { holdId: target.id, reason: refusal.message, issues: [...refusal.issues] },
    });
  });
}

/**
 * Voids a hold that will not be captured again and records it, with what it
 * released (its amount less its captures, computed: PayPal's voided
 * authorisation keeps its original amount, U0's P4).
 *
 * @param deps - The database and the PayPal client.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @param target - The hold.
 * @returns Resolves once recorded.
 * @throws MoneyError when PayPal refuses the void or cannot be reached.
 */
async function voidStep(
  deps: MoneyDependencies,
  practiceId: string,
  caseId: string,
  target: HoldView,
): Promise<void> {
  if (target.capturedPence >= target.amount.pence) {
    throw new MoneyError("wrong_state", `hold ${target.id} is fully captured: it is never voided`);
  }
  await asking(
    deps.db,
    refusedEvent({ id: caseId, practiceId }, "system", "hold.void_refused", {
      orderId: target.paypalOrderId,
      authorizationId: target.authorizationId!,
    }),
    () =>
      askPayPal("void the hold", () =>
        voidAuthorization(
          deps.paypal,
          target.authorizationId!,
          holdRequestId(caseId, target.id, "void"),
        ),
      ),
  );
  await deps.db.transaction(async (tx) => {
    const kase = await lockCase(tx, practiceId, caseId);
    await tx
      .update(hold)
      .set({ status: "voided", closedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(hold.id, target.id), eq(hold.status, "authorised")));
    const to = await dischargedState(tx, kase);
    await moveCase(tx, caseId, to);
    const releasedPence = target.amount.pence - target.capturedPence;
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: "system",
      action: "hold.voided",
      moneyStateBefore: kase.moneyState,
      moneyStateAfter: to,
      amount: { pence: releasedPence, currency: target.amount.currency },
      paypal: { orderId: target.paypalOrderId, authorizationId: target.authorizationId! },
      detail: {
        holdId: target.id,
        closedBy: target.capturedPence > 0 ? "non_final_capture_and_void" : "void",
        releasedPence,
      },
    });
  });
}

/**
 * Where discharge has brought the case, from its holds: released once every
 * hold is closed with anything left over, captured once every hold is closed
 * with nothing left or once a capture has landed, else as it was.
 *
 * @param tx - The open transaction holding the case's lock, after the step's change.
 * @param kase - The locked case.
 * @returns The state.
 */
async function dischargedState(tx: Transaction, kase: LockedCase): Promise<MoneyState> {
  const holds = (await caseHolds(tx, kase.id)).filter((one) => one.authorizationId !== null);
  const open = holds.some((one) => one.status === "authorised");
  const captured = holds.reduce((sum, one) => sum + one.capturedPence, 0);
  const released = holds.reduce((sum, one) => sum + one.releasedPence, 0);
  if (!open) {
    return released > 0 ? "released" : "captured";
  }
  return captured > 0 ? "captured" : kase.moneyState;
}

/**
 * What a discharge did, read from the case.
 *
 * @param executor - The pool.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The result.
 */
async function dischargeResult(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<DischargeResult> {
  const shares = await billShares(executor, practiceId, caseId);
  const money = await caseMoney(executor, practiceId, caseId);
  const holds = money.holds;
  return {
    state: money.state,
    billedPence: [...shares.values()].reduce((sum, one) => sum + one, 0),
    capturedPence: holds.reduce((sum, one) => sum + one.capturedPence, 0),
    releasedPence: holds.reduce((sum, one) => sum + one.releasedPence, 0),
    unpaidPence: holds
      .filter((one) => one.status === "expired")
      .reduce((sum, one) => sum + (shares.get(one.id) ?? 0) - one.capturedPence, 0),
    holds,
  };
}

/**
 * Checks the lines done against the latest approved estimate and allocates
 * them to the case's authorised holds.
 *
 * @param tx - The open transaction holding the case's lock.
 * @param kase - The locked case.
 * @param lines - The lines done.
 * @returns The plan.
 * @throws MoneyError when the case holds nothing, or a line is refused.
 */
async function planBill(
  tx: Transaction,
  kase: LockedCase,
  lines: readonly z.output<typeof billLineInput>[],
): Promise<DischargePlan> {
  const holds = (await caseHolds(tx, kase.id)).filter((one) => one.status === "authorised");
  if (holds.length === 0) {
    throw new MoneyError("wrong_state", "the case holds nothing to discharge against");
  }
  const versions = await Promise.all(
    holds.map(async (one) => (await loadEstimateVersion(tx, kase.practiceId, one.id))!),
  );
  const approved = versions.at(-1)!;
  const priced = priceBillLines(approved, lines);

  const approvals = new Map(
    approvalsByHold(
      versions.map((version) => ({
        holdId: version.id,
        items: version.lines.map((line) => ({ code: line.code, highPence: line.highPence })),
      })),
    ).map((one) => [one.id, one.approved]),
  );
  const allocatable: AllocatableHold[] = holds.map((one) => ({
    id: one.id,
    amountPence: one.amount.pence,
    approved: approvals.get(one.id) ?? new Map(),
  }));
  const plan = allocateBill(
    allocatable,
    priced.map((line) => ({ code: line.code, amountPence: line.amountPence })),
  );
  return {
    currency: kase.currency,
    lines: priced.map((line, at) => ({
      ...line,
      parts: plan.byLine[at]!.map((part) => ({
        holdId: part.holdId,
        amountPence: part.amountPence,
      })),
    })),
    holds: holds.map((one) => {
      const capturePence = plan.byHold.get(one.id) ?? 0;
      return {
        holdId: one.id,
        versionNumber: one.versionNumber,
        amountPence: one.amount.pence,
        capturePence,
        releasePence: one.amount.pence - capturePence,
        closeBy: capturePence > 0 ? "final_capture" : "void",
      };
    }),
    billedPence: plan.billedPence,
    heldPence: plan.heldPence,
    releasedPence: plan.releasedPence,
  };
}

/**
 * Prices the lines done from the estimate lines they fulfil, refusing a line
 * not on the latest approved estimate (an update declined freezes scope
 * there), a line given twice, and a quantity above the one approved.
 *
 * @param approved - The latest approved estimate version.
 * @param lines - The lines done.
 * @returns The priced lines, without their allocation.
 * @throws MoneyError naming every refused line.
 */
function priceBillLines(
  approved: EstimateVersionView,
  lines: readonly z.output<typeof billLineInput>[],
): Omit<PlannedBillLine, "parts">[] {
  const byId = new Map(approved.lines.map((line) => [line.id, line]));
  const issues: string[] = [];
  const seen = new Set<string>();
  const priced: Omit<PlannedBillLine, "parts">[] = [];
  lines.forEach((line, at) => {
    const estimated = byId.get(line.estimateLineId);
    if (!estimated) {
      issues.push(`line ${at + 1}: ${NOT_ON_ESTIMATE}`);
      return;
    }
    if (seen.has(line.estimateLineId)) {
      issues.push(`line ${at + 1}: ${estimated.code} is on the bill already`);
      return;
    }
    seen.add(line.estimateLineId);
    if (line.quantity > estimated.quantityHigh) {
      issues.push(
        `line ${at + 1}: ${line.quantity} ${estimated.unit} of ${estimated.code} done, ${estimated.quantityHigh} approved. Send an update to charge the rest.`,
      );
      return;
    }
    priced.push({
      estimateLineId: estimated.id,
      code: estimated.code,
      name: estimated.ownerWording ?? estimated.name,
      quantity: line.quantity,
      unitPricePence: estimated.unitPricePence,
      amountPence: estimated.unitPricePence * line.quantity,
    });
  });
  if (issues.length > 0) {
    throw new MoneyError("bill_refused", `bill refused: ${issues.join("; ")}`);
  }
  return priced;
}

/**
 * PayPal's capture status as the database stores it.
 *
 * @param status - PayPal's status.
 * @returns The stored status.
 */
function lowerStatus(status: z.infer<typeof paypalCaptureStatus>) {
  return status.toLowerCase() as Lowercase<typeof status>;
}
