import { and, eq, isNotNull, like, max, or } from "drizzle-orm";

import type { Executor } from "@/db/client";
import { auditEvent } from "@/db/schema";

/**
 * The day's stamp (U8b): the id of the practice's latest audit event that
 * can change what the day shows, which is a change of a case's money state
 * (U3's transitions, each carrying `money_state_after`: the booking's
 * colour) or an act on the schedule (`schedule.*`: a hold, a move, a
 * release). The open day asks after it every few seconds and reads itself
 * again when it has moved, so a case turning held recolours without a reload.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @returns The stamp: the event's id, or "0" before any such event.
 */
export async function dayStamp(executor: Executor, practiceId: string): Promise<string> {
  const [latest] = await executor
    .select({ id: max(auditEvent.id) })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.practiceId, practiceId),
        or(isNotNull(auditEvent.moneyStateAfter), like(auditEvent.action, "schedule.%")),
      ),
    );
  return String(latest?.id ?? 0);
}
