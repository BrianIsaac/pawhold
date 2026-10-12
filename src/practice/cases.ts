import { and, desc, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Executor } from "@/db/client";
import { auditEvent, estimateLine, estimateVersion, patientCase } from "@/db/schema";
import { type CaseMoney, caseMoney } from "@/money/view";

import { firstName, type MoneyChip, moneyChips, nextStep } from "./chips";
import { PracticeError } from "./errors";

/** The longest name or procedure a case keeps. */
export const MAX_CASE_FIELD = 100;

const caseField = z
  .string()
  .trim()
  .min(1, "Enter this")
  .max(MAX_CASE_FIELD, `At most ${MAX_CASE_FIELD} characters`);

/** A new case as the practice types it. */
export const openCaseInput = z.strictObject({
  patientName: caseField,
  ownerName: caseField,
  procedure: caseField,
  vetName: caseField,
});

const openCaseRequest = openCaseInput.extend({ practiceId: z.uuid() });

/**
 * Parses a request, turning a malformed one into a refusal that names each
 * faulty field in words the vet reads; the refusal's message says to look at
 * them.
 *
 * @param schema - The request's schema.
 * @param request - The request.
 * @returns The parsed request.
 * @throws PracticeError `request_invalid`, with each field's fault.
 */
export function parsePracticeRequest<T extends z.ZodType>(
  schema: T,
  request: unknown,
): z.output<T> {
  const parsed = schema.safeParse(request);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "");
      fields[field] ??= issue.message;
    }
    throw new PracticeError("request_invalid", "Check the fields marked below.", fields);
  }
  return parsed.data;
}

/**
 * Opens a case: an animal admitted for one treatment pathway (plan 3.2),
 * under the vet whose name its estimates' approvals carry, with
 * `case.opened` written by the vet.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the patient, the owner, the procedure and the vet.
 * @returns The new case's id.
 * @throws PracticeError `request_invalid` naming each field at fault.
 */
export async function openCase(
  executor: Executor,
  request: z.input<typeof openCaseRequest>,
): Promise<string> {
  const { practiceId, ...kase } = parsePracticeRequest(openCaseRequest, request);
  return executor.transaction(async (tx) => {
    const [opened] = await tx
      .insert(patientCase)
      .values({ practiceId, ...kase })
      .returning({ id: patientCase.id, moneyState: patientCase.moneyState });
    await appendAuditEvent(tx, {
      practiceId,
      caseId: opened!.id,
      actor: "vet",
      action: "case.opened",
      moneyStateAfter: opened!.moneyState,
      detail: kase,
    });
    return opened!.id;
  });
}

/** A case as today's list shows it. */
export interface TodayCase {
  readonly id: string;
  readonly patientName: string;
  readonly ownerName: string;
  readonly procedure: string;
  readonly vetName: string | null;
  readonly money: CaseMoney;
  readonly chips: readonly MoneyChip[];
  readonly next: string;
}

/**
 * The practice's cases for today's list, the one with the latest activity on
 * its audit trail first, each with its money chips and the next thing to do.
 * Every case of the practice is listed: a judge's practice is a day's work
 * (plan 7.4); U8a's schedule gives the day its own bookings.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @returns The cases.
 */
export async function todaysCases(executor: Executor, practiceId: string): Promise<TodayCase[]> {
  const latest = executor
    .select({ caseId: auditEvent.caseId, at: max(auditEvent.occurredAt).as("latest_at") })
    .from(auditEvent)
    .where(eq(auditEvent.practiceId, practiceId))
    .groupBy(auditEvent.caseId)
    .as("latest");
  const drafted = executor
    .selectDistinct({ caseId: estimateVersion.caseId })
    .from(estimateVersion)
    .innerJoin(estimateLine, eq(estimateLine.versionId, estimateVersion.id))
    .where(and(eq(estimateVersion.practiceId, practiceId), isNull(estimateVersion.sentAt)))
    .as("drafted");
  const rows = await executor
    .select({
      id: patientCase.id,
      patientName: patientCase.patientName,
      ownerName: patientCase.ownerName,
      procedure: patientCase.procedure,
      vetName: patientCase.vetName,
      hasDraftLines: sql<boolean>`${drafted.caseId} is not null`,
    })
    .from(patientCase)
    .leftJoin(latest, eq(latest.caseId, patientCase.id))
    .leftJoin(drafted, eq(drafted.caseId, patientCase.id))
    .where(eq(patientCase.practiceId, practiceId))
    .orderBy(
      desc(sql`coalesce(${latest.at}, ${patientCase.updatedAt})`),
      desc(patientCase.createdAt),
    );
  return Promise.all(
    rows.map(async ({ hasDraftLines, ...row }) => {
      const money = await caseMoney(executor, practiceId, row.id);
      return {
        ...row,
        money,
        chips: moneyChips(money),
        next: nextStep(money.state, { ownerFirstName: firstName(row.ownerName), hasDraftLines }),
      };
    }),
  );
}
