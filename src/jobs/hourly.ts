import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { reconcilePendingWebhooks, type ReconcileReport } from "@/money/reconcile";
import type { PayPalClient } from "@/paypal/client";

import { reauthoriseHolds, type ReauthoriseReport } from "./reauthorise";

/** What the hourly job needs. */
export interface HourlyDependencies {
  readonly db: Database["db"];
  /** The PayPal client, or null when the sandbox app's credentials are not set. */
  readonly paypal: PayPalClient | null;
  readonly now?: Date;
}

/** What one run of the hourly job did. */
export interface HourlyReport {
  readonly databaseReached: boolean;
  /** The reauthorisation rule's run, or null when PayPal's credentials are not set. */
  readonly reauthorisation: ReauthoriseReport | null;
  /** The sweep of stored webhooks not yet reconciled. */
  readonly webhooks: ReconcileReport;
  readonly sessionsPruned: number;
}

/**
 * The hourly job Render's cron runs (plan 7.3): the reauthorisation rule and
 * the sweep of webhooks left unreconciled (U3); the judge-session clean-up
 * (U9) lands here too. Each part is idempotent, so a run repeated or
 * overlapping changes nothing twice.
 *
 * @param deps - The database, the PayPal client and the clock.
 * @returns What the run did.
 */
export async function runHourly(deps: HourlyDependencies): Promise<HourlyReport> {
  await deps.db.execute(sql`select 1`);
  const now = deps.now ?? new Date();
  const reauthorisation = deps.paypal
    ? await reauthoriseHolds({ db: deps.db, paypal: deps.paypal, now })
    : null;
  const webhooks = await reconcilePendingWebhooks(deps.db, { now });
  return { databaseReached: true, reauthorisation, webhooks, sessionsPruned: 0 };
}
