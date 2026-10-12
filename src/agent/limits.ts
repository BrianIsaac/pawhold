import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Executor } from "@/db/client";
import { auditEvent } from "@/db/schema";

/**
 * The plan's per-session draft cap (D8: "for example 40 an hour"). A judge's
 * session has a practice of its own, so the cap is counted per practice.
 */
export const DEFAULT_DRAFTS_PER_HOUR = 40;

/** The audit actions that record one ask of the model. */
export const MODEL_CALL_ACTIONS = ["estimate.drafted", "estimate.update_drafted"] as const;

/**
 * The agent's settings: `AGENT_DRAFTS_PER_HOUR`, a whole number of model
 * calls a practice may make in an hour, or `off` to lift the cap (D8: the cap
 * is dropped if the hackathon's answer is that it is a restriction).
 */
export const agentEnvironment = z.object({
  AGENT_DRAFTS_PER_HOUR: z
    .union([z.literal("off"), z.string().regex(/^[1-9]\d{0,5}$/)])
    .default(String(DEFAULT_DRAFTS_PER_HOUR))
    .transform((value) => (value === "off" ? null : Number(value))),
});

/**
 * How many times a practice's drafts and updates asked the model in the last
 * hour, read from the audit trail. Cached answers and capped presses did not
 * ask it and are not counted.
 *
 * @param db - The database.
 * @param practiceId - The practice.
 * @returns The count.
 */
export async function modelCallsInLastHour(db: Executor, practiceId: string): Promise<number> {
  const [row] = await db
    .select({ calls: count() })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.practiceId, practiceId),
        inArray(auditEvent.action, [...MODEL_CALL_ACTIONS]),
        sql`${auditEvent.detail} ->> 'source' = 'model'`,
        gt(auditEvent.occurredAt, sql`now() - interval '1 hour'`),
      ),
    );
  return row?.calls ?? 0;
}
