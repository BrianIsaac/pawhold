import { eq } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Database, Executor } from "@/db/client";
import { practice } from "@/db/schema";

import { ScheduleError } from "./errors";

/**
 * Whether a zone is one the platform's clock knows.
 *
 * @param zone - An IANA zone name.
 * @returns Whether `Intl` accepts it.
 */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The practice's schedule settings: the agent's lead time and the practice's clock. */
export const scheduleSettingsInput = z.strictObject({
  practiceId: z.uuid(),
  leadMinutes: z.int().min(5).max(240),
  timeZone: z.string().min(1).max(64).refine(knownZone, "a time zone the clock knows"),
});

/** The settings as the schedule reads them. */
export interface ScheduleSettings {
  /** How long before a procedure an unanswered update makes the agent hold its slot. */
  readonly leadMinutes: number;
  /** The zone the practice reads its times in. */
  readonly timeZone: string;
}

/**
 * A practice's schedule settings (default: 30 minutes, Europe/London).
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @returns The settings.
 * @throws ScheduleError `not_found` when there is no such practice.
 */
export async function scheduleSettings(
  executor: Executor,
  practiceId: string,
): Promise<ScheduleSettings> {
  const [found] = await executor
    .select({ leadMinutes: practice.scheduleLeadMinutes, timeZone: practice.timeZone })
    .from(practice)
    .where(eq(practice.id, practiceId));
  if (!found) {
    throw new ScheduleError("not_found", "There is no such practice.");
  }
  return found;
}

/**
 * Changes a practice's lead time and clock, as an audit event in the same transaction.
 *
 * @param db - The database.
 * @param input - The practice and its new settings.
 * @returns The settings now kept.
 * @throws ScheduleError `request_invalid` for a lead time outside 5 to 240 minutes or an unknown zone; `not_found` for no such practice.
 */
export async function setScheduleSettings(
  db: Database["db"],
  input: z.input<typeof scheduleSettingsInput>,
): Promise<ScheduleSettings> {
  const parsed = scheduleSettingsInput.safeParse(input);
  if (!parsed.success) {
    throw new ScheduleError("request_invalid", z.prettifyError(parsed.error));
  }
  const { practiceId, leadMinutes, timeZone } = parsed.data;
  return db.transaction(async (tx) => {
    const previous = await scheduleSettings(tx, practiceId);
    await tx
      .update(practice)
      .set({ scheduleLeadMinutes: leadMinutes, timeZone })
      .where(eq(practice.id, practiceId));
    await appendAuditEvent(tx, {
      practiceId,
      actor: "vet",
      action: "practice.schedule_settings_changed",
      detail: { leadMinutes, timeZone, previous: { ...previous } },
    });
    return { leadMinutes, timeZone };
  });
}
