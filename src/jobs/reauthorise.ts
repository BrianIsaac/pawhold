import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";

import { appendAuditEvent } from "@/audit/writer";
import type { Database, Transaction } from "@/db/client";
import { bill, hold } from "@/db/schema";
import { askPayPal, MoneyError } from "@/money/errors";
import { holdRequestId } from "@/money/holds";
import { lockCase } from "@/money/state";
import { currencyCode } from "@/money/currency";
import type { PayPalClient } from "@/paypal/client";
import { parsePayPalTime, reauthorizeAuthorization } from "@/paypal/payments";

/** PayPal's honour period: "the first 3 days of an authorization" (/payment-methods/auth-honor). */
export const HONOUR_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

/** The authorisation period: "Valid for 29 days" (/payment-methods/auth-honor). */
export const AUTHORISATION_PERIOD_MS = 29 * 24 * 60 * 60 * 1000;

/** What the job needs. */
export interface ReauthoriseDependencies {
  readonly db: Database["db"];
  readonly paypal: PayPalClient;
  readonly now?: Date;
  /** One practice's holds only (a judge's practice, or a test's); every practice's by default. */
  readonly practiceId?: string;
}

/** What one run of the job did, by hold id. */
export interface ReauthoriseReport {
  /** Wallet holds reauthorised (`hold.reauthorised`). */
  readonly reauthorised: string[];
  /** Holds past their honour period that cannot be reauthorised (`hold.honour_period_over`). */
  readonly flagged: string[];
  /** Wallet holds PayPal said were too soon to reauthorise: left for the next run. */
  readonly tooSoon: string[];
  /** Wallet holds whose reauthorisation PayPal refused for good (`hold.reauthorise_refused`). */
  readonly refused: string[];
  /** Holds PayPal could not be asked about this run (no answer): left for the next run. */
  readonly failed: string[];
}

type HoldRow = typeof hold.$inferSelect;

/**
 * The reauthorisation rule (plan 3.2, as U0's P5 (a) left it), run hourly: a
 * PayPal-account (wallet) hold past its three-day honour period and inside
 * its 29 days, whose case is not being discharged and which has not been
 * reauthorised, is reauthorised once ("A reauthorization is only allowed once
 * from Day 4 to Day 29", PayPal's answer to P5 (a)); captures and voids then
 * go against the new authorisation. A card hold past day 3 is flagged
 * (`hold.honour_period_over`) and never reauthorised: PayPal documents
 * reauthorisation for PayPal-account payments only. A wallet hold whose one
 * reauthorisation is spent or refused, or that is past its 29 days, is
 * flagged when its honour period is over in turn; so is a hold whose bill is
 * signed off but whose capture has not landed (never reauthorised: its
 * discharge is resumed hourly instead). Each hold is reviewed in one
 * transaction holding its case's lock across PayPal's answer, so a sign-off
 * and its discharge never interleave with a reauthorisation, and a run
 * repeated, or two at once, change nothing twice. One hold's failure is
 * reported and the run goes on; PayPal's too-soon refusal leaves the hold for
 * the next run.
 *
 * Unverified until P5 (b) (17 October 2026): the sandbox's answer to a
 * reauthorisation on day 4 or later. The code follows PayPal's documented
 * answer (a new authorisation id, `CREATED`).
 *
 * @param deps - The database, the PayPal client and the clock.
 * @returns What the run did.
 */
export async function reauthoriseHolds(deps: ReauthoriseDependencies): Promise<ReauthoriseReport> {
  const now = deps.now ?? new Date();
  const report: ReauthoriseReport = {
    reauthorised: [],
    flagged: [],
    tooSoon: [],
    refused: [],
    failed: [],
  };
  const open = await deps.db
    .select({ id: hold.id, practiceId: hold.practiceId, caseId: hold.caseId })
    .from(hold)
    .where(
      and(
        eq(hold.status, "authorised"),
        isNull(hold.honourPeriodFlaggedAt),
        lte(hold.authorisedAt, new Date(now.getTime() - HONOUR_PERIOD_MS)),
        deps.practiceId ? eq(hold.practiceId, deps.practiceId) : undefined,
      ),
    )
    .orderBy(asc(hold.authorisedAt));

  for (const candidate of open) {
    try {
      for (const outcome of await reviewHold(deps, candidate, now)) {
        report[outcome].push(candidate.id);
      }
    } catch (error) {
      console.error("pawhold: reauthorisation rule failed for a hold", {
        holdId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
      report.failed.push(candidate.id);
    }
  }
  return report;
}

type Outcome = keyof ReauthoriseReport;

/**
 * Applies the rule to one hold in one transaction holding its case's lock,
 * across PayPal's answer too: a sign-off, and so a discharge, waits for it,
 * and it sees a sign-off made before it. The hold is read again under the
 * lock, so what the batch selected is never acted on stale.
 *
 * @param deps - The database and the PayPal client.
 * @param candidate - The hold as selected.
 * @param candidate.id - The hold.
 * @param candidate.practiceId - Its practice.
 * @param candidate.caseId - Its case.
 * @param now - The clock.
 * @returns What became of it.
 */
async function reviewHold(
  deps: ReauthoriseDependencies,
  candidate: { id: string; practiceId: string; caseId: string },
  now: Date,
): Promise<Outcome[]> {
  return deps.db.transaction(async (tx) => {
    await lockCase(tx, candidate.practiceId, candidate.caseId);
    const [row] = await tx.select().from(hold).where(eq(hold.id, candidate.id)).for("update");
    if (!row || row.status !== "authorised" || row.honourPeriodFlaggedAt !== null) {
      return [];
    }
    const [signed] = await tx.select({ id: bill.id }).from(bill).where(eq(bill.caseId, row.caseId));
    const billed = signed !== undefined;
    const outcomes: Outcome[] = [];
    let current = row;
    if (!billed && canReauthorise(row, now)) {
      const done = await reauthorise(tx, deps.paypal, row, now);
      outcomes.push(done.outcome);
      if (done.outcome !== "refused") {
        return outcomes;
      }
      current = done.row;
    }
    if (honourPeriodOver(current, now, billed)) {
      await flag(tx, current, now, billed);
      outcomes.push("flagged");
    }
    return outcomes;
  });
}

/**
 * Whether the rule may still reauthorise a hold: a wallet hold, never
 * reauthorised nor refused, inside its 29 days.
 *
 * @param row - The hold.
 * @param now - The clock.
 * @returns True when it may.
 */
function canReauthorise(row: HoldRow, now: Date): boolean {
  return (
    row.paymentKind === "paypal" &&
    row.reauthorisedAt === null &&
    row.reauthoriseRefusedAt === null &&
    now.getTime() - row.authorisedAt!.getTime() < AUTHORISATION_PERIOD_MS
  );
}

/**
 * Whether a hold that will not be reauthorised is past the honour period it
 * has: its own, or its reauthorisation's.
 *
 * @param row - The hold.
 * @param now - The clock.
 * @param billed - Whether its case's bill is signed off (never reauthorised then).
 * @returns True when it is.
 */
function honourPeriodOver(row: HoldRow, now: Date, billed: boolean): boolean {
  const from = row.reauthorisedAt ?? row.authorisedAt!;
  return (
    (billed || !canReauthorise(row, now)) && now.getTime() - from.getTime() >= HONOUR_PERIOD_MS
  );
}

/**
 * Reauthorises one wallet hold and records PayPal's answer, inside the
 * transaction holding its case's lock.
 *
 * @param tx - The open transaction.
 * @param paypal - The PayPal client.
 * @param row - The hold, locked.
 * @param now - The clock.
 * @returns What became of it, and the hold as it now stands.
 */
async function reauthorise(
  tx: Transaction,
  paypal: PayPalClient,
  row: HoldRow,
  now: Date,
): Promise<{ outcome: Outcome; row: HoldRow }> {
  let renewed;
  try {
    renewed = await askPayPal("reauthorise the hold", () =>
      reauthorizeAuthorization(
        paypal,
        row.authorizationId!,
        holdRequestId(row.caseId, row.id, "reauthorize"),
        { pence: row.amountPence, currency: currencyCode.parse(row.currencyCode) },
      ),
    );
  } catch (error) {
    if (!(error instanceof MoneyError)) {
      throw error;
    }
    if (error.issues.includes("REAUTHORIZATION_TOO_SOON")) {
      return { outcome: "tooSoon", row };
    }
    if (error.reason !== "paypal_refused") {
      console.error("pawhold: reauthorisation not answered", {
        holdId: row.id,
        error: error.message,
      });
      return { outcome: "failed", row };
    }
    const [refused] = await tx
      .update(hold)
      .set({ reauthoriseRefusedAt: now, updatedAt: sql`now()` })
      .where(eq(hold.id, row.id))
      .returning();
    await appendAuditEvent(tx, {
      practiceId: row.practiceId,
      caseId: row.caseId,
      actor: "system",
      action: "hold.reauthorise_refused",
      paypal: {
        orderId: row.paypalOrderId,
        authorizationId: row.authorizationId!,
        ...(error.debugId ? { debugId: error.debugId } : {}),
      },
      detail: { holdId: row.id, reason: error.message, issues: [...error.issues] },
    });
    return { outcome: "refused", row: refused! };
  }

  if (renewed.status !== "CREATED") {
    console.error("pawhold: reauthorisation answered without holding", {
      holdId: row.id,
      status: renewed.status,
    });
    return { outcome: "failed", row };
  }
  const reauthorisedAt = renewed.create_time ? parsePayPalTime(renewed.create_time) : now;
  const expiresAt = renewed.expiration_time ? parsePayPalTime(renewed.expiration_time) : null;
  const [updated] = await tx
    .update(hold)
    .set({
      authorizationId: renewed.id,
      reauthorisedAt,
      ...(expiresAt ? { expiresAt } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(hold.id, row.id))
    .returning();
  await appendAuditEvent(tx, {
    practiceId: row.practiceId,
    caseId: row.caseId,
    actor: "system",
    action: "hold.reauthorised",
    amount: { pence: row.amountPence, currency: currencyCode.parse(row.currencyCode) },
    paypal: { orderId: row.paypalOrderId, authorizationId: renewed.id },
    detail: {
      holdId: row.id,
      previousAuthorizationId: row.authorizationId,
      originalAuthorizationId: row.originalAuthorizationId,
      authorisedAt: row.authorisedAt!.toISOString(),
      newStatus: renewed.status,
    },
  });
  return { outcome: "reauthorised", row: updated! };
}

/**
 * Flags a hold past its honour period, inside the transaction holding its
 * case's lock.
 *
 * @param tx - The open transaction.
 * @param row - The hold, locked.
 * @param now - The clock.
 * @param billed - Whether its case's bill is signed off.
 * @returns Resolves once flagged.
 */
async function flag(tx: Transaction, row: HoldRow, now: Date, billed: boolean): Promise<void> {
  await tx
    .update(hold)
    .set({ honourPeriodFlaggedAt: now, updatedAt: sql`now()` })
    .where(eq(hold.id, row.id));
  await appendAuditEvent(tx, {
    practiceId: row.practiceId,
    caseId: row.caseId,
    actor: "system",
    action: "hold.honour_period_over",
    amount: { pence: row.amountPence, currency: currencyCode.parse(row.currencyCode) },
    paypal: { orderId: row.paypalOrderId, authorizationId: row.authorizationId! },
    detail: {
      holdId: row.id,
      paymentKind: row.paymentKind,
      reason: billed
        ? "its bill is signed off and its capture has not landed"
        : row.paymentKind === "card"
          ? "a card hold is never reauthorised: PayPal documents reauthorisation for PayPal accounts only"
          : row.reauthorisedAt
            ? "reauthorised once, which is all PayPal allows; its new honour period is over"
            : row.reauthoriseRefusedAt
              ? "PayPal refused to reauthorise it"
              : "it is past its 29 days and was never reauthorised",
      honourPeriodFrom: (row.reauthorisedAt ?? row.authorisedAt!).toISOString(),
    },
  });
}
