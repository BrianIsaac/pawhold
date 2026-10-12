import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { type CleanupReport, pruneJudgeSessions } from "@/judge/cleanup";
import { type ResumedDischarges, resumeStalledDischarges } from "@/money/discharge";
import { reconcilePendingWebhooks, type ReconcileReport } from "@/money/reconcile";
import type { PayPalClient } from "@/paypal/client";
import { sweepSchedule, type SweepReport } from "@/schedule/agent";

import { reauthoriseHolds, type ReauthoriseReport } from "./reauthorise";

/** The parts of the hourly run, each given the database, the clock and, for PayPal's, the client. */
export interface HourlyParts {
  readonly reauthorisation: (deps: PartDependencies) => Promise<ReauthoriseReport>;
  readonly discharges: (deps: PartDependencies) => Promise<ResumedDischarges>;
  readonly webhooks: (db: Database["db"], now: Date) => Promise<ReconcileReport>;
  /** The schedule agent's sweep of every practice's day (U8a); it never calls PayPal. */
  readonly schedule: (db: Database["db"], now: Date) => Promise<SweepReport>;
  /**
   * The judge-mode clean-up (U9): judge sessions past their seven days pruned
   * once PayPal holds nothing for them; without credentials, only those PayPal
   * holds nothing for.
   */
  readonly sessions: (deps: SessionPartDependencies) => Promise<CleanupReport>;
}

/** What the clean-up part needs: the client is null when the credentials are not set. */
interface SessionPartDependencies {
  readonly db: Database["db"];
  readonly paypal: PayPalClient | null;
  readonly now: Date;
}

/** What a PayPal part of the run needs. */
interface PartDependencies {
  readonly db: Database["db"];
  readonly paypal: PayPalClient;
  readonly now: Date;
}

/** What the hourly job needs. */
export interface HourlyDependencies {
  readonly db: Database["db"];
  /** The PayPal client, or null when the sandbox app's credentials are not set. */
  readonly paypal: PayPalClient | null;
  readonly now?: Date;
  /** The parts to run; U3's and U8a's by default. A test replaces one to see the others run. */
  readonly parts?: Partial<HourlyParts>;
}

/** What one run of the hourly job did. */
export interface HourlyReport {
  readonly databaseReached: boolean;
  /** The reauthorisation rule's run, or null when it did not run (no credentials, or it failed). */
  readonly reauthorisation: ReauthoriseReport | null;
  /** The discharges resumed, or null when they were not (no credentials, or the sweep failed). */
  readonly discharges: ResumedDischarges | null;
  /** The sweep of stored webhooks not yet reconciled, or null when it failed. */
  readonly webhooks: ReconcileReport | null;
  /** The schedule agent's sweep (U8a), or null when it failed. */
  readonly schedule: SweepReport | null;
  /** The judge-mode clean-up (U9), or null when it failed. */
  readonly sessions: CleanupReport | null;
  /** How many judge sessions the clean-up pruned. */
  readonly sessionsPruned: number;
  /** Each part that failed whole, as `part: message`. */
  readonly errors: string[];
}

const DEFAULT_PARTS: HourlyParts = {
  reauthorisation: (deps) => reauthoriseHolds(deps),
  discharges: (deps) => resumeStalledDischarges(deps),
  webhooks: (db, now) => reconcilePendingWebhooks(db, { now }),
  schedule: (db, now) => sweepSchedule(db, { now }),
  sessions: (deps) => pruneJudgeSessions(deps),
};

/**
 * The hourly job Render's cron runs (plan 7.3): the reauthorisation rule, the
 * resumption of discharges stopped after their sign-off, and the sweep of
 * webhooks left unreconciled (U3); the schedule agent's sweep of the day
 * (U8a), which needs no PayPal credentials; and the judge-session clean-up
 * (U9), last, so a stalled discharge is resumed before its practice's holds
 * are released. Each part is idempotent and runs whatever became of the
 * others: a part that fails whole is reported in `errors`.
 *
 * @param deps - The database, the PayPal client, the clock and the parts.
 * @returns What the run did.
 */
export async function runHourly(deps: HourlyDependencies): Promise<HourlyReport> {
  await deps.db.execute(sql`select 1`);
  const now = deps.now ?? new Date();
  const parts = { ...DEFAULT_PARTS, ...deps.parts };
  const errors: string[] = [];
  const attempt = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const paypal = deps.paypal;
  const reauthorisation = paypal
    ? await attempt("reauthorisation", () => parts.reauthorisation({ db: deps.db, paypal, now }))
    : null;
  const discharges = paypal
    ? await attempt("discharges", () => parts.discharges({ db: deps.db, paypal, now }))
    : null;
  const webhooks = await attempt("webhooks", () => parts.webhooks(deps.db, now));
  const schedule = await attempt("schedule", () => parts.schedule(deps.db, now));
  const sessions = await attempt("sessions", () => parts.sessions({ db: deps.db, paypal, now }));
  return {
    databaseReached: true,
    reauthorisation,
    discharges,
    webhooks,
    schedule,
    sessions,
    sessionsPruned: sessions?.pruned.length ?? 0,
    errors,
  };
}
