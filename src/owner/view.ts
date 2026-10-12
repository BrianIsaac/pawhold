import { and, eq } from "drizzle-orm";

import type { Executor } from "@/db/client";
import { patientCase, practice } from "@/db/schema";

/** Who a case is for and who sent it, as the owner's pages name them. */
export interface OwnerCaseHeader {
  readonly practiceName: string;
  readonly patientName: string;
  readonly ownerName: string;
}

/**
 * The names an owner's page heads with.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The names, or null when the practice has no such case.
 */
export async function ownerCaseHeader(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<OwnerCaseHeader | null> {
  const [found] = await executor
    .select({
      practiceName: practice.name,
      patientName: patientCase.patientName,
      ownerName: patientCase.ownerName,
    })
    .from(patientCase)
    .innerJoin(practice, eq(practice.id, patientCase.practiceId))
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));
  return found ?? null;
}
