"use server";

import { revalidatePath } from "next/cache";

import { sweepSchedule } from "@/schedule/agent";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

/** What one on-demand check of the day answers. */
export interface DayCheck {
  /** When the agent checked the day, ISO 8601; null when the session has gone. */
  readonly checkedAt: string | null;
  /** Whether the check held, released or withdrew anything. */
  readonly changed: boolean;
}

/**
 * The schedule agent, on demand (U8a's brief, item 3): sweeps the signed-in
 * practice's day as the hourly job sweeps every practice's, so a slot inside
 * the lead time is held while the day is open rather than at the next hour.
 * The day is shown afresh either way, so a case the owner answered meanwhile
 * shows its new state.
 *
 * @returns When it checked, and whether anything changed.
 */
export async function checkTheDayAction(): Promise<DayCheck> {
  const session = await currentPracticeSession();
  if (!session) {
    return { checkedAt: null, changed: false };
  }
  const now = new Date();
  const report = await sweepSchedule(database().db, { practiceId: session.practiceId, now });
  revalidatePath("/day");
  return {
    checkedAt: now.toISOString(),
    changed: report.held.length + report.released.length + report.withdrawn.length > 0,
  };
}
