import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";

/** What one run of the hourly job did. */
export interface HourlyReport {
  readonly databaseReached: boolean;
  readonly reauthorised: number;
  readonly sessionsPruned: number;
}

/**
 * The hourly job Render's cron runs (plan 7.3): the reauthorisation rule
 * (U3) and the judge-session clean-up (U9) land here. Until then it checks
 * the database and does nothing else.
 *
 * @param db - The database.
 * @returns What the run did.
 */
export async function runHourly(db: Database["db"]): Promise<HourlyReport> {
  await db.execute(sql`select 1`);
  return { databaseReached: true, reauthorised: 0, sessionsPruned: 0 };
}
