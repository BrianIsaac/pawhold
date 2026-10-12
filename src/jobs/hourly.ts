import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { type ResumedDischarges, resumeStalledDischarges } from "@/money/discharge";
import { reconcilePendingWebhooks, type ReconcileReport } from "@/money/reconcile";
import type { PayPalClient } from "@/paypal/client";

import { reauthoriseHolds, type ReauthoriseReport } from "./reauthorise";

/** The parts of the hourly run, each given the database, the PayPal client and the clock. */
export interface HourlyParts {
  readonly reauthorisation: (deps: PartDependencies) => Promise<ReauthoriseReport>;
  readonly discharges: (deps: PartDependencies) => Promise<ResumedDischarges>;
  readonly webhooks: (db: Database["db"], now: Date) => Promise<ReconcileReport>;
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
  /** The parts to run; U3's by default. A test replaces one to see the others run. */
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
  readonly sessionsPruned: number;
  /** Each part that failed whole, as `part: message`. */
  readonly errors: string[];
}

const U3_PARTS: HourlyParts = {
  reauthorisation: (deps) => reauthoriseHolds(deps),
  discharges: (deps) => resumeStalledDischarges(deps),
  webhooks: (db, now) => reconcilePendingWebhooks(db, { now }),
};

/**
 * The hourly job Render's cron runs (plan 7.3): the reauthorisation rule, the
 * resumption of discharges stopped after their sign-off, and the sweep of
 * webhooks left unreconciled (U3); the judge-session clean-up (U9) lands here
 * too. Each part is idempotent and runs whatever became of the others: a part
 * that fails whole is reported in `errors`.
 *
 * @param deps - The database, the PayPal client, the clock and the parts.
 * @returns What the run did.
 */
export async function runHourly(deps: HourlyDependencies): Promise<HourlyReport> {
  await deps.db.execute(sql`select 1`);
  const now = deps.now ?? new Date();
  const parts = { ...U3_PARTS, ...deps.parts };
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
  return {
    databaseReached: true,
    reauthorisation,
    discharges,
    webhooks,
    sessionsPruned: 0,
    errors,
  };
}
