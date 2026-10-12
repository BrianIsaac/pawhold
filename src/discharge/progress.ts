import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Executor } from "@/db/client";
import { auditEvent, bill, capture } from "@/db/schema";
import { type CurrencyCode, currencyCode } from "@/money/currency";
import { caseHolds, TAKEN_CAPTURE } from "@/money/view";

import { holdTitle } from "./wording";

/**
 * How long a discharge with a hold still open may go without a step landing
 * before the page offers to resume it: longer than one PayPal call may take (the client waits
 * 20 s), far shorter than the hourly job's ten minutes.
 */
export const STALL_AFTER_MS = 45_000;

/** One step of a hold's discharge that landed: what moved, when, and when PayPal's webhook confirmed it. */
export interface ProgressStep {
  readonly pence: number;
  readonly at: Date;
  /** "Confirmed by PayPal": when the webhook for it was reconciled; null until then. */
  readonly confirmedAt: Date | null;
}

/** One hold's part of the discharge, as it lands. */
export interface HoldProgress {
  readonly holdId: string;
  /** "The first hold", "The update's hold". */
  readonly name: string;
  readonly amountPence: number;
  /** What the signed-off bill takes from it. */
  readonly plannedCapturePence: number;
  /** What the signed-off bill leaves of it, to be released. */
  readonly plannedReleasePence: number;
  /** What its capture took, once it landed. */
  readonly capture: ProgressStep | null;
  /** What it released, once it closed with anything left over. */
  readonly release: ProgressStep | null;
  /** Whether PayPal refused a step for it since the bill was signed off, and it is still open. */
  readonly refused: boolean;
  /** Whether PayPal found it expired, its share unpaid. */
  readonly expired: boolean;
}

/** Work no approved estimate covered, noted on the bill and not charged. */
export interface NotedWork {
  readonly code: string;
  readonly name: string;
  readonly quantity: number;
  /** What it would have cost at the list's price. */
  readonly amountPence: number;
}

/** A discharge, from its sign-off to its last hold closed and confirmed. */
export interface DischargeProgress {
  readonly signedOffAt: Date;
  /** When the discharge last moved: its last step landed or was refused, or its sign-off. */
  readonly lastStepAt: Date;
  readonly currency: CurrencyCode;
  readonly billedPence: number;
  readonly holds: readonly HoldProgress[];
  readonly capturedPence: number;
  readonly releasedPence: number;
  /** The share of the bill on holds PayPal found expired. */
  readonly unpaidPence: number;
  readonly work: readonly NotedWork[];
  /** Whether every hold the bill was signed off against is closed. */
  readonly finished: boolean;
  /** Whether PayPal's webhook has confirmed every capture and release that landed. */
  readonly confirmed: boolean;
  /** Whether it stopped part way and can be resumed. */
  readonly stalled: boolean;
}

/** What `bill.signed_off` keeps of each hold (U3). */
const signedOffDetail = z.object({
  holds: z.array(z.object({ holdId: z.uuid(), capturePence: z.int(), releasePence: z.int() })),
});

/** What `bill.work_not_charged` keeps. */
const workDetail = z.object({
  items: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      quantity: z.int(),
      listPricePence: z.int(),
    }),
  ),
});

/** The refusals of a discharge's steps U3 writes to the trail. */
const REFUSALS = ["hold.capture_refused", "hold.capture_declined", "hold.void_refused"];

/** The trail's events for a discharge's steps, landed or refused. */
const STEPS = ["hold.captured", "hold.voided", "hold.expired", ...REFUSALS];

/**
 * A case's discharge as it stands, for the page to show each hold's capture
 * and release as they land and "Confirmed by PayPal" on each from the
 * webhook's tick: a capture is confirmed when its webhook is reconciled
 * (U3's `confirmedAt`); a release by a final capture below the hold with that
 * capture (PayPal releases the rest with it, U0's P2), and a release by a
 * void when `PAYMENT.AUTHORIZATION.VOIDED` is reconciled for the hold.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @param now - The clock, for whether it stalled.
 * @returns The progress, or null when no bill is signed off.
 */
export async function dischargeProgress(
  executor: Executor,
  practiceId: string,
  caseId: string,
  now: Date = new Date(),
): Promise<DischargeProgress | null> {
  const [signed] = await executor
    .select()
    .from(bill)
    .where(and(eq(bill.caseId, caseId), eq(bill.practiceId, practiceId)));
  if (!signed) {
    return null;
  }
  const events = await executor
    .select()
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.caseId, caseId),
        eq(auditEvent.practiceId, practiceId),
        gte(auditEvent.occurredAt, signed.signedOffAt),
      ),
    )
    .orderBy(asc(auditEvent.id));
  const signedOff = events.find((event) => event.action === "bill.signed_off");
  if (!signedOff) {
    // U3 writes the bill and its event in one transaction: a bill without one is not U3's.
    throw new Error(`bill ${signed.id} of case ${caseId} has no bill.signed_off event`);
  }
  const planned = signedOffDetail.parse(signedOff.detail).holds;
  const lastStepAt = events
    .filter((event) => STEPS.includes(event.action))
    .reduce(
      (latest, event) => (event.occurredAt > latest ? event.occurredAt : latest),
      signed.signedOffAt,
    );
  const work = events.find((event) => event.action === "bill.work_not_charged");
  const all = await caseHolds(executor, caseId);
  const holds = planned.map((part) => ({ part, held: all.find((one) => one.id === part.holdId)! }));
  const captures =
    holds.length === 0
      ? []
      : await executor
          .select()
          .from(capture)
          .where(
            and(
              inArray(
                capture.holdId,
                holds.map(({ held }) => held.id),
              ),
              inArray(capture.status, [...TAKEN_CAPTURE]),
            ),
          )
          .orderBy(asc(capture.sequence));

  const progress = holds.map(({ part, held }, at): HoldProgress => {
    const taken = captures.filter((one) => one.holdId === held.id);
    const last = taken.at(-1);
    const captureStep: ProgressStep | null = last
      ? {
          pence: held.capturedPence,
          at: last.capturedAt,
          confirmedAt: taken.every((one) => one.confirmedAt !== null)
            ? (taken.map((one) => one.confirmedAt!).sort((a, b) => b.getTime() - a.getTime())[0] ??
              null)
            : null,
        }
      : null;
    let release: ProgressStep | null = null;
    if (held.releasedPence > 0 && held.status !== "expired") {
      const voidConfirmed = events.find(
        (event) =>
          event.action === "webhook.reconciled" &&
          (event.detail as Record<string, unknown>).eventType === "PAYMENT.AUTHORIZATION.VOIDED" &&
          (event.detail as Record<string, unknown>).holdId === held.id,
      );
      release = {
        pence: held.releasedPence,
        at: held.closedAt ?? signed.signedOffAt,
        confirmedAt:
          held.status === "voided"
            ? (voidConfirmed?.occurredAt ?? null)
            : (captureStep?.confirmedAt ?? null),
      };
    }
    return {
      holdId: held.id,
      name: holdTitle(at, holds.length),
      amountPence: held.amount.pence,
      plannedCapturePence: part.capturePence,
      plannedReleasePence: part.releasePence,
      capture: captureStep,
      release,
      refused:
        held.status === "authorised" &&
        events.some(
          (event) =>
            REFUSALS.includes(event.action) && event.paypalAuthorizationId === held.authorizationId,
        ),
      expired: held.status === "expired",
    };
  });

  const finished = holds.every(({ held }) => held.status !== "authorised");
  const steps = progress.flatMap((one) => [one.capture, one.release]).filter((one) => one !== null);
  return {
    signedOffAt: signed.signedOffAt,
    lastStepAt,
    currency: currencyCode.parse(signed.currencyCode),
    billedPence: signed.totalPence,
    holds: progress,
    capturedPence: holds.reduce((sum, { held }) => sum + held.capturedPence, 0),
    releasedPence: holds.reduce((sum, { held }) => sum + held.releasedPence, 0),
    unpaidPence: holds
      .filter(({ held }) => held.status === "expired")
      .reduce((sum, { part, held }) => sum + part.capturePence - held.capturedPence, 0),
    work: work
      ? workDetail.parse(work.detail).items.map((item) => ({
          code: item.code,
          name: item.name,
          quantity: item.quantity,
          amountPence: item.listPricePence,
        }))
      : [],
    finished,
    confirmed: finished && steps.every((one) => one.confirmedAt !== null),
    stalled:
      !finished &&
      (progress.some((one) => one.refused) ||
        now.getTime() - lastStepAt.getTime() >= STALL_AFTER_MS),
  };
}

/** A landed step as the page receives it: its times as ISO 8601. */
export interface ProgressStepJson {
  readonly pence: number;
  readonly at: string;
  readonly confirmedAt: string | null;
}

/** The progress as the page receives it, from the server's first render and from each poll. */
export interface DischargeProgressJson extends Omit<
  DischargeProgress,
  "signedOffAt" | "lastStepAt" | "holds"
> {
  readonly signedOffAt: string;
  readonly lastStepAt: string;
  readonly holds: readonly (Omit<HoldProgress, "capture" | "release"> & {
    readonly capture: ProgressStepJson | null;
    readonly release: ProgressStepJson | null;
  })[];
}

/**
 * The progress with its times as ISO 8601, for the page.
 *
 * @param progress - The progress.
 * @returns The same, serialisable.
 */
export function progressJson(progress: DischargeProgress): DischargeProgressJson {
  const step = (one: ProgressStep | null): ProgressStepJson | null =>
    one
      ? {
          pence: one.pence,
          at: one.at.toISOString(),
          confirmedAt: one.confirmedAt?.toISOString() ?? null,
        }
      : null;
  return {
    ...progress,
    signedOffAt: progress.signedOffAt.toISOString(),
    lastStepAt: progress.lastStepAt.toISOString(),
    holds: progress.holds.map((one) => ({
      ...one,
      capture: step(one.capture),
      release: step(one.release),
    })),
  };
}
