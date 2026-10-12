import { and, asc, eq, isNull, notExists, sql } from "drizzle-orm";

import { appendAuditEvent } from "@/audit/writer";
import type { Database } from "@/db/client";
import { bill, hold } from "@/db/schema";
import { askPayPal, MoneyError } from "@/money/errors";
import { holdRequestId } from "@/money/holds";
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
 * reauthorisation is spent, or refused, is flagged when its honour period is
 * over in turn. Every rule reads the hold's own record, so a run repeated, or
 * two runs at once, change nothing twice; PayPal's too-soon refusal leaves the
 * hold for the next run.
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
    .select()
    .from(hold)
    .where(
      and(
        eq(hold.status, "authorised"),
        isNull(hold.honourPeriodFlaggedAt),
        deps.practiceId ? eq(hold.practiceId, deps.practiceId) : undefined,
        notExists(
          deps.db
            .select({ one: sql`1` })
            .from(bill)
            .where(eq(bill.caseId, hold.caseId)),
        ),
      ),
    )
    .orderBy(asc(hold.authorisedAt));

  for (const row of open) {
    const sinceAuthorised = now.getTime() - row.authorisedAt!.getTime();
    if (sinceAuthorised < HONOUR_PERIOD_MS) {
      continue;
    }
    const reauthorisable =
      row.paymentKind === "paypal" &&
      row.reauthorisedAt === null &&
      row.reauthoriseRefusedAt === null &&
      sinceAuthorised < AUTHORISATION_PERIOD_MS;
    if (reauthorisable) {
      const done = await reauthorise(deps, row, now);
      report[done].push(row.id);
      if (done !== "refused") {
        continue;
      }
    }
    const current = (await deps.db.select().from(hold).where(eq(hold.id, row.id)))[0]!;
    if (honourPeriodOver(current, now) && (await flag(deps, current, now))) {
      report.flagged.push(row.id);
    }
  }
  return report;
}

/**
 * Whether a hold that will not be reauthorised is past the honour period it has.
 *
 * @param row - The hold.
 * @param now - The clock.
 * @returns True when it is.
 */
function honourPeriodOver(row: HoldRow, now: Date): boolean {
  const from = row.reauthorisedAt ?? row.authorisedAt!;
  const canStillReauthorise =
    row.paymentKind === "paypal" &&
    row.reauthorisedAt === null &&
    row.reauthoriseRefusedAt === null;
  return !canStillReauthorise && now.getTime() - from.getTime() >= HONOUR_PERIOD_MS;
}

/**
 * Reauthorises one wallet hold and records PayPal's answer.
 *
 * @param deps - The database and the PayPal client.
 * @param row - The hold.
 * @param now - The clock.
 * @returns What became of it.
 */
async function reauthorise(
  deps: ReauthoriseDependencies,
  row: HoldRow,
  now: Date,
): Promise<"reauthorised" | "tooSoon" | "refused" | "failed"> {
  let renewed;
  try {
    renewed = await askPayPal("reauthorise the hold", () =>
      reauthorizeAuthorization(
        deps.paypal,
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
      return "tooSoon";
    }
    if (error.reason !== "paypal_refused") {
      console.error("pawhold: reauthorisation not answered", {
        holdId: row.id,
        error: error.message,
      });
      return "failed";
    }
    await deps.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(hold)
        .set({ reauthoriseRefusedAt: now, updatedAt: sql`now()` })
        .where(and(eq(hold.id, row.id), isNull(hold.reauthoriseRefusedAt)))
        .returning({ id: hold.id });
      if (updated) {
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
      }
    });
    return "refused";
  }

  await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(hold)
      .set({
        authorizationId: renewed.id,
        reauthorisedAt: renewed.create_time ? parsePayPalTime(renewed.create_time) : now,
        ...(renewed.expiration_time ? { expiresAt: parsePayPalTime(renewed.expiration_time) } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(hold.id, row.id), isNull(hold.reauthorisedAt)))
      .returning();
    if (updated) {
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
    }
  });
  return "reauthorised";
}

/**
 * Flags a hold past its honour period, once.
 *
 * @param deps - The database.
 * @param row - The hold.
 * @param now - The clock.
 * @returns True when this run flagged it.
 */
async function flag(deps: ReauthoriseDependencies, row: HoldRow, now: Date): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(hold)
      .set({ honourPeriodFlaggedAt: now, updatedAt: sql`now()` })
      .where(and(eq(hold.id, row.id), isNull(hold.honourPeriodFlaggedAt)))
      .returning({ id: hold.id });
    if (!updated) {
      return false;
    }
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
        reason:
          row.paymentKind === "card"
            ? "a card hold is never reauthorised: PayPal documents reauthorisation for PayPal accounts only"
            : row.reauthorisedAt
              ? "reauthorised once, which is all PayPal allows; its new honour period is over"
              : "PayPal refused to reauthorise it",
        honourPeriodFrom: (row.reauthorisedAt ?? row.authorisedAt!).toISOString(),
      },
    });
    return true;
  });
}
