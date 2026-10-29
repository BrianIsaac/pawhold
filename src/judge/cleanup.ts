import { and, asc, eq, exists, gt, inArray, lte, notExists, notLike } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Database, Executor } from "@/db/client";
import { auditEvent, bill, hold, practice, session } from "@/db/schema";
import { currencyCode } from "@/money/currency";
import { dischargedState } from "@/money/discharge";
import { askPayPal, MoneyError } from "@/money/errors";
import { holdRequestId, reauthorisationDetail, voidTarget } from "@/money/holds";
import { lockCase, moveCase } from "@/money/state";
import { caseHolds } from "@/money/view";
import { type PayPalClient, PayPalError } from "@/paypal/client";
import { getOrder, paymentKindOf } from "@/paypal/orders";
import {
  type Authorization,
  getAuthorization,
  parsePayPalTime,
  voidAuthorization,
} from "@/paypal/payments";
import { isSeededPayPalId, SEEDED_ID_PREFIX } from "@/paypal/seeded";

/** An authorisation PayPal still holds money on. */
const HOLDING: ReadonlySet<Authorization["status"]> = new Set(["CREATED", "PARTIALLY_CAPTURED"]);

/** Holds that may stand at PayPal unknown to pawhold: the order's answer may never have come back. */
const UNRECORDED = ["ordered", "withdrawn", "declined"] as const;

/** Why the clean-up closes a hold, on its `hold.voided`. */
const SESSION_ENDED = "the judge's session ended after seven days";

/** Why the clean-up closes a hold whose authorisation PayPal had let expire, on its `hold.expired`. */
const EXPIRED_AT_PAYPAL =
  "PayPal refused the void: the authorisation had run its 29 days and expired, and PayPal had released the money itself";

/**
 * The statuses an authorisation past its `expiration_time` may read back in
 * once PayPal refuses its void: `CREATED`, the status it was made in, and
 * `EXPIRED`, which PayPal's published schema does not list (read 29 October
 * 2026) but which says no more than the passed expiration does. A capture's
 * status took money no void gives back, and any other status is not read.
 */
const EXPIRES_FROM: ReadonlySet<string> = new Set(["CREATED", "EXPIRED"]);

const dependencies = z.object({
  practiceIds: z.array(z.uuid()).optional(),
});

/** What the clean-up needs. */
export interface CleanupDependencies {
  readonly db: Database["db"];
  /** The PayPal client, or null when the sandbox app's credentials are not set. */
  readonly paypal: PayPalClient | null;
  readonly now?: Date;
  /** These practices only (a test's, on a shared database); every judge practice by default. */
  readonly practiceIds?: readonly string[];
}

/** What one run of the clean-up did. */
export interface CleanupReport {
  /** The sessions pruned. */
  readonly pruned: string[];
  /** The holds voided at PayPal, or found voided there, and recorded voided. */
  readonly voided: string[];
  /** The holds whose authorisation PayPal had let expire, recorded expired. */
  readonly expired: string[];
  /** Practices whose expired sessions wait for a later run: PayPal could not be asked about a hold. */
  readonly waiting: string[];
}

/**
 * The judge-mode clean-up (plan 7.4), a part of the hourly job: for each
 * judge practice whose sessions have all run their seven days, every hold
 * the judge made is released at PayPal first, as U3's "To U9" says (each
 * `authorised` hold voided by its authorisation, and each `ordered`,
 * `withdrawn` or `declined` hold's order read for an authorisation PayPal
 * holds that pawhold never recorded, which is voided too), then the sessions
 * are pruned with `judge.session.pruned`. A seeded hold (`SEEDED` ids) is
 * never sent to PayPal; a showcase practice is never touched; no row but a
 * session's is ever deleted (U1's rule: the audit trail and the money rows
 * refuse it). A practice whose holds cannot all be settled this run (no
 * credentials, no answer from PayPal, or a signed bill whose discharge has
 * not landed) keeps its sessions until a run that can; each void carries a
 * `PayPal-Request-Id` of its own, so a run repeated, or two at once, void
 * once. A practice already pruned is visited again whenever it holds an
 * authorised hold (an owner's authorise in flight as it was pruned), and an
 * owner's link to it opens nothing ({@link judgePracticeEnded}).
 *
 * @param deps - The database, the PayPal client, the clock and an optional scope.
 * @returns What the run did.
 */
export async function pruneJudgeSessions(deps: CleanupDependencies): Promise<CleanupReport> {
  const { practiceIds } = dependencies.parse({ practiceIds: deps.practiceIds });
  const now = deps.now ?? new Date();
  const report: CleanupReport = { pruned: [], voided: [], expired: [], waiting: [] };
  const ended = await deps.db
    .selectDistinct({ practiceId: session.practiceId })
    .from(session)
    .innerJoin(practice, eq(practice.id, session.practiceId))
    .where(
      and(
        eq(practice.kind, "judge"),
        lte(session.expiresAt, now),
        practiceIds ? inArray(session.practiceId, practiceIds) : undefined,
      ),
    );

  const reopened = await deps.db
    .selectDistinct({ practiceId: hold.practiceId })
    .from(hold)
    .innerJoin(practice, eq(practice.id, hold.practiceId))
    .where(
      and(
        eq(practice.kind, "judge"),
        eq(hold.status, "authorised"),
        notLike(hold.paypalOrderId, `${SEEDED_ID_PREFIX}%`),
        exists(prunedEvent(deps.db, hold.practiceId)),
        notExists(liveSession(deps.db, hold.practiceId, now)),
        practiceIds ? inArray(hold.practiceId, practiceIds) : undefined,
      ),
    );
  const visits = [...new Set([...ended, ...reopened].map((one) => one.practiceId))].map(
    (practiceId) => ({ practiceId }),
  );

  for (const { practiceId } of visits) {
    const [live] = await deps.db
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.practiceId, practiceId), gt(session.expiresAt, now)))
      .limit(1);
    const closed = { voided: 0, expired: 0 };
    if (!live) {
      const released = await releaseHolds(deps, practiceId, now);
      report.voided.push(...released.voided);
      report.expired.push(...released.expired);
      closed.voided = released.voided.length;
      closed.expired = released.expired.length;
      if (!released.settled) {
        report.waiting.push(practiceId);
        continue;
      }
    }
    report.pruned.push(...(await pruneSessions(deps.db, practiceId, now, closed)));
  }
  return report;
}

/**
 * Whether a judge's practice has ended: pruned by the clean-up, with no
 * session of it still live. An owner's link to such a practice opens
 * nothing, so nothing can be held for it after the clean-up released it.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param now - The clock.
 * @returns True when it has ended.
 */
export async function judgePracticeEnded(
  executor: Executor,
  practiceId: string,
  now: Date,
): Promise<boolean> {
  const [ended] = await executor
    .select({ id: practice.id })
    .from(practice)
    .where(
      and(
        eq(practice.id, practiceId),
        eq(practice.kind, "judge"),
        exists(prunedEvent(executor, practice.id)),
        notExists(liveSession(executor, practice.id, now)),
      ),
    );
  return ended !== undefined;
}

/**
 * The practice's `judge.session.pruned` events, for an `exists`.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice's id column.
 * @returns The subquery.
 */
function prunedEvent(executor: Executor, practiceId: typeof practice.id | typeof hold.practiceId) {
  return executor
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(
      and(eq(auditEvent.practiceId, practiceId), eq(auditEvent.action, "judge.session.pruned")),
    );
}

/**
 * The practice's sessions still live, for an `exists`.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice's id column.
 * @param now - The clock.
 * @returns The subquery.
 */
function liveSession(
  executor: Executor,
  practiceId: typeof practice.id | typeof hold.practiceId,
  now: Date,
) {
  return executor
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.practiceId, practiceId), gt(session.expiresAt, now)));
}

/**
 * Releases at PayPal every hold of a practice the judge made, and records
 * each one closed.
 *
 * @param deps - The database and the PayPal client.
 * @param practiceId - The practice.
 * @param now - The clock.
 * @returns The holds closed, by how, and whether every hold is settled.
 */
async function releaseHolds(
  deps: CleanupDependencies,
  practiceId: string,
  now: Date,
): Promise<{ voided: string[]; expired: string[]; settled: boolean }> {
  const holds = (
    await deps.db
      .select()
      .from(hold)
      .where(
        and(eq(hold.practiceId, practiceId), inArray(hold.status, ["authorised", ...UNRECORDED])),
      )
      .orderBy(asc(hold.createdAt))
  ).filter((one) => !isSeededPayPalId(one.paypalOrderId));
  if (holds.length === 0) {
    return { voided: [], expired: [], settled: true };
  }
  if (!deps.paypal) {
    return { voided: [], expired: [], settled: false };
  }
  const billed = new Set(
    (
      await deps.db
        .select({ caseId: bill.caseId })
        .from(bill)
        .where(eq(bill.practiceId, practiceId))
    ).map((one) => one.caseId),
  );
  const voided: string[] = [];
  const expired: string[] = [];
  let settled = true;
  for (const one of holds) {
    if (one.status === "authorised" && billed.has(one.caseId)) {
      // Its bill is signed off: the hourly job resumes its discharge, which closes it.
      settled = false;
      continue;
    }
    try {
      const closed =
        one.status === "authorised"
          ? await releaseAuthorised(deps.db, deps.paypal, one, now)
          : await releaseUnrecorded(deps.db, deps.paypal, one, now);
      if (closed === "voided") {
        voided.push(one.id);
      } else if (closed === "expired") {
        expired.push(one.id);
      }
    } catch (error) {
      if (!(error instanceof MoneyError)) {
        throw error;
      }
      console.error("pawhold: the clean-up could not release a hold", {
        holdId: one.id,
        error: error.message,
        issues: error.issues,
        debugId: error.debugId,
      });
      settled = false;
    }
  }
  return { voided, expired, settled };
}

type HoldRow = typeof hold.$inferSelect;

/** How an authorisation the clean-up released stands closed at PayPal. */
type Released =
  { readonly as: "voided" } | { readonly as: "expired"; readonly refusal: MoneyError };

/**
 * Voids an authorisation, or finds it closed at PayPal already. When PayPal
 * refuses the void, the authorisation is read back: `VOIDED` (voided before,
 * by a void whose answer was lost) is released as voided; one past its
 * `expiration_time` (its 29 days run out, PayPal having released the money
 * itself) as expired, read in `CREATED` or `EXPIRED` ({@link EXPIRES_FROM}).
 * Anything else leaves the refusal standing, its message naming what PayPal
 * read back: `CAPTURED` and `PARTIALLY_CAPTURED` took money no void gives
 * back, `CREATED` inside its 29 days still holds it, and any other status
 * PayPal's published schema does not list is not known to be closed (the
 * clean-up writes no flag for it, U20's decision 4).
 *
 * @param paypal - The PayPal client.
 * @param authorizationId - The authorisation voided, and read back after a refusal: a reauthorised hold's original parent ({@link voidTarget}).
 * @param requestId - The void's `PayPal-Request-Id`.
 * @param step - The void, in words, for a refusal's message.
 * @param now - The clock the expiration is read against.
 * @returns How the authorisation stands closed.
 * @throws MoneyError when PayPal could not be reached, or refused with the authorisation not closed.
 */
async function voidOrFindReleased(
  paypal: PayPalClient,
  authorizationId: string,
  requestId: string,
  step: string,
  now: Date,
): Promise<Released> {
  try {
    await askPayPal(step, () => voidAuthorization(paypal, authorizationId, requestId));
    return { as: "voided" };
  } catch (error) {
    if (!(error instanceof MoneyError) || error.reason !== "paypal_refused") {
      throw error;
    }
    const read = await askPayPal("read the authorisation", () =>
      getAuthorization(paypal, authorizationId),
    );
    if (read.status === "VOIDED") {
      return { as: "voided" };
    }
    const expiresAt = expirationOf(read);
    if (EXPIRES_FROM.has(read.status) && expiresAt && expiresAt <= now) {
      return { as: "expired", refusal: error };
    }
    throw new MoneyError(
      error.reason,
      `${error.message} (PayPal reads authorisation ${authorizationId} ${read.status}, expiring ${read.expiration_time ?? "at no time given"})`,
      error.detail,
    );
  }
}

/**
 * When an authorisation PayPal read back expires, by its own `expiration_time`.
 *
 * @param read - The authorisation.
 * @returns The instant, or null when PayPal gave none or one that does not parse.
 */
function expirationOf(read: Authorization): Date | null {
  if (!read.expiration_time) {
    return null;
  }
  try {
    return parsePayPalTime(read.expiration_time);
  } catch {
    return null;
  }
}

/**
 * Voids an authorised hold at PayPal and records it closed, as a discharge's
 * void is recorded (`hold.voided`, the case moved as discharge moves it). A
 * reauthorised hold is voided, and read back, through its original parent
 * ({@link voidTarget}), and its event names the reauthorisation too.
 * When PayPal refuses because the authorisation is voided there already, it
 * is recorded voided all the same; when it refuses because the
 * authorisation has expired, the hold is recorded expired as a discharge
 * records one (`hold.expired`), the case moved the same way, since PayPal
 * has released the money.
 *
 * @param db - The database.
 * @param paypal - The PayPal client.
 * @param row - The hold.
 * @param now - The clock.
 * @returns How the hold was closed, or null when another run closed it first.
 * @throws MoneyError when PayPal could not be reached, or refused with the authorisation not closed.
 */
async function releaseAuthorised(
  db: Database["db"],
  paypal: PayPalClient,
  row: HoldRow,
  now: Date,
): Promise<Released["as"] | null> {
  const target = voidTarget(row, "void.session_end");
  const released = await voidOrFindReleased(
    paypal,
    target.authorizationId,
    target.requestId,
    "void the hold",
    now,
  );

  return db.transaction(async (tx) => {
    const kase = await lockCase(tx, row.practiceId, row.caseId);
    const [closed] = await tx
      .update(hold)
      .set({ status: released.as, closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(hold.id, row.id), eq(hold.status, "authorised")))
      .returning();
    if (!closed) {
      return null;
    }
    const to = await dischargedState(tx, kase);
    await moveCase(tx, row.caseId, to);
    const { releasedPence } = (await caseHolds(tx, row.caseId)).find((one) => one.id === row.id)!;
    await appendAuditEvent(tx, {
      practiceId: row.practiceId,
      caseId: row.caseId,
      actor: "system",
      action: released.as === "expired" ? "hold.expired" : "hold.voided",
      moneyStateBefore: kase.moneyState,
      moneyStateAfter: to,
      amount: { pence: releasedPence, currency: currencyCode.parse(row.currencyCode) },
      paypal: {
        orderId: row.paypalOrderId,
        authorizationId: target.authorizationId,
        ...refusalIds(released),
      },
      detail: {
        holdId: row.id,
        closedBy: "session_end",
        reason: released.as === "expired" ? EXPIRED_AT_PAYPAL : SESSION_ENDED,
        releasedPence,
        ...reauthorisationDetail(target),
        ...refusalIssues(released),
      },
    });
    return released.as;
  });
}

/**
 * PayPal's `debug_id` for an expiry found by a refused void, for the audit
 * event's PayPal ids.
 *
 * @param released - How the authorisation stands closed.
 * @returns The `debugId`, or nothing.
 */
function refusalIds(released: Released): { debugId?: string } {
  return released.as === "expired" && released.refusal.debugId
    ? { debugId: released.refusal.debugId }
    : {};
}

/**
 * PayPal's issue names for an expiry found by a refused void, for the audit
 * event's detail, as a discharge's `hold.expired` carries them.
 *
 * @param released - How the authorisation stands closed.
 * @returns The `issues`, or nothing.
 */
function refusalIssues(released: Released): { issues?: string[] } {
  return released.as === "expired" ? { issues: [...released.refusal.issues] } : {};
}

/**
 * Reads the order of a hold pawhold never saw authorised and voids any
 * authorisation PayPal holds on it (U3's decision 17), recording the
 * authorisation on the hold, closed, as U3's late authorisation is. A void
 * PayPal refuses is read back as {@link voidOrFindReleased} reads it, and
 * the hold is recorded as its recorded authorisation stands closed: voided,
 * or expired.
 *
 * @param db - The database.
 * @param paypal - The PayPal client.
 * @param row - The hold.
 * @param now - The clock.
 * @returns How the hold was closed, or null when PayPal held nothing on its order.
 * @throws MoneyError when PayPal could not be reached, or refused with an authorisation not closed.
 */
async function releaseUnrecorded(
  db: Database["db"],
  paypal: PayPalClient,
  row: HoldRow,
  now: Date,
): Promise<Released["as"] | null> {
  let order;
  try {
    order = await askPayPal("read the order", () => getOrder(paypal, row.paypalOrderId));
  } catch (error) {
    // An order PayPal no longer has holds nothing.
    if (
      error instanceof MoneyError &&
      error.detail.cause instanceof PayPalError &&
      error.detail.cause.status === 404
    ) {
      return null;
    }
    throw error;
  }
  const holding = (order.purchase_units ?? [])
    .flatMap((unit) => unit.payments?.authorizations ?? [])
    .filter((found) => HOLDING.has(found.status));
  const [authorisation] = holding;
  if (!authorisation) {
    return null;
  }
  const closures: Released[] = [];
  for (const [index, found] of holding.entries()) {
    closures.push(
      await voidOrFindReleased(
        paypal,
        found.id,
        holdRequestId(row.caseId, row.id, `void.session_end.${index + 1}`),
        "void the authorisation",
        now,
      ),
    );
  }
  const released = closures[0]!;

  return db.transaction(async (tx) => {
    await lockCase(tx, row.practiceId, row.caseId);
    const createdAt = authorisation.create_time
      ? parsePayPalTime(authorisation.create_time)
      : new Date();
    const [closed] = await tx
      .update(hold)
      .set({
        status: released.as,
        authorizationId: authorisation.id,
        originalAuthorizationId: authorisation.id,
        paymentKind: paymentKindOf(order) ?? "paypal",
        authorisedAt: createdAt,
        expiresAt: authorisation.expiration_time
          ? parsePayPalTime(authorisation.expiration_time)
          : null,
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(hold.id, row.id), inArray(hold.status, [...UNRECORDED])))
      .returning();
    if (!closed) {
      return null;
    }
    await appendAuditEvent(tx, {
      practiceId: row.practiceId,
      caseId: row.caseId,
      actor: "system",
      action: released.as === "expired" ? "hold.expired" : "hold.voided",
      amount: { pence: row.amountPence, currency: currencyCode.parse(row.currencyCode) },
      paypal: {
        orderId: row.paypalOrderId,
        authorizationId: authorisation.id,
        ...refusalIds(released),
      },
      detail: {
        holdId: row.id,
        closedBy: "session_end",
        reason: `${released.as === "expired" ? EXPIRED_AT_PAYPAL : SESSION_ENDED}; PayPal held the ${row.status} hold's order unknown to pawhold`,
        releasedPence: row.amountPence,
        ...refusalIssues(released),
      },
    });
    return released.as;
  });
}

/**
 * Deletes a practice's sessions that have run their course, each with
 * `judge.session.pruned`; the practice and everything in it stay.
 *
 * @param db - The database.
 * @param practiceId - The practice.
 * @param now - The clock.
 * @param closed - How many holds were released for it this run, by how.
 * @param closed.voided - The holds voided, or found voided.
 * @param closed.expired - The holds found expired.
 * @returns The sessions pruned.
 */
async function pruneSessions(
  db: Database["db"],
  practiceId: string,
  now: Date,
  closed: { voided: number; expired: number },
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const gone = await tx
      .delete(session)
      .where(and(eq(session.practiceId, practiceId), lte(session.expiresAt, now)))
      .returning();
    for (const one of gone) {
      await appendAuditEvent(tx, {
        practiceId,
        actor: "system",
        action: "judge.session.pruned",
        detail: {
          sessionId: one.id,
          door: one.door,
          startedAt: one.createdAt.toISOString(),
          expiredAt: one.expiresAt.toISOString(),
          holdsVoided: closed.voided,
          holdsExpired: closed.expired,
        },
      });
    }
    return gone.map((one) => one.id);
  });
}
