import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Executor, Transaction } from "@/db/client";
import { patientCase } from "@/db/schema";
import {
  caseEstimateVersions,
  EstimateError,
  type EstimateLineInput,
  type EstimateVersionView,
  loadEstimateVersion,
  makeEstimateVersion,
  replaceDraftLines,
} from "@/estimate/version";

import type { AskContext } from "./ask";
import { DEFAULT_DRAFTS_PER_HOUR } from "./limits";
import type { DraftModel } from "./model";

/** What the agent's jobs are given. */
export interface AgentDependencies {
  readonly db: Executor;
  readonly model: DraftModel;
  /**
   * Model calls a practice may make in an hour (D8); null lifts the cap.
   * {@link DEFAULT_DRAFTS_PER_HOUR} when not given.
   */
  readonly draftsPerHour?: number | null;
}

/** A case's estimate as a job finds it. */
export interface CaseEstimateState {
  readonly patientName: string;
  /** The draft open on the case, if any. */
  readonly open: EstimateVersionView | null;
  /** The last version sent to the owner, if any. */
  readonly lastSent: EstimateVersionView | null;
}

/**
 * The ask context for a practice under the dependencies' cap.
 *
 * @param dependencies - The jobs' dependencies.
 * @param practiceId - The practice asking.
 * @returns The context.
 */
export function askContext(dependencies: AgentDependencies, practiceId: string): AskContext {
  return {
    db: dependencies.db,
    model: dependencies.model,
    practiceId,
    draftsPerHour:
      dependencies.draftsPerHour === undefined
        ? DEFAULT_DRAFTS_PER_HOUR
        : dependencies.draftsPerHour,
  };
}

/**
 * Reads a case's estimate: its open draft and its last sent version.
 *
 * @param db - The database.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The case's state.
 * @throws EstimateError `case_not_found` when the case is not the practice's.
 */
export async function caseEstimateState(
  db: Executor,
  practiceId: string,
  caseId: string,
): Promise<CaseEstimateState> {
  const [kase] = await db
    .select({ patientName: patientCase.patientName })
    .from(patientCase)
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));
  if (!kase) {
    throw new EstimateError("case_not_found", `the practice has no case ${caseId}`);
  }
  const versions = await caseEstimateVersions(db, practiceId, caseId);
  return {
    patientName: kase.patientName,
    open: versions.find((version) => version.sentAt === null) ?? null,
    lastSent: versions.filter((version) => version.sentAt !== null).at(-1) ?? null,
  };
}

/** What {@link writeDraft} writes. */
export interface DraftWrite {
  readonly practiceId: string;
  readonly caseId: string;
  readonly open: EstimateVersionView | null;
  readonly lines: readonly EstimateLineInput[];
  /** Whether the model gave nothing usable. */
  readonly failed: boolean;
}

/**
 * Writes a job's lines: replaces the open draft's lines (pressing "Draft"
 * again redrafts), or makes the case's next version when none is open. When
 * the model failed, an open draft is left as it was, so a failed redraft
 * never loses the vet's lines; with none open, the version is made from the
 * lines given (none for a first draft, the sent lines for an update), for the
 * vet to fill by hand.
 *
 * @param tx - The transaction.
 * @param write - The practice, the case, the open draft, the lines and whether the model failed.
 * @returns The draft as written.
 */
export async function writeDraft(tx: Transaction, write: DraftWrite): Promise<EstimateVersionView> {
  const { practiceId, caseId, open, lines, failed } = write;
  if (open && failed) {
    return (await loadEstimateVersion(tx, practiceId, open.id))!;
  }
  if (open) {
    return replaceDraftLines(tx, { practiceId, versionId: open.id, actor: "system", lines });
  }
  return makeEstimateVersion(tx, { practiceId, caseId, actor: "system", lines });
}

/**
 * Parses a job's request, refusing a malformed one as U2 does.
 *
 * @param schema - The request's schema.
 * @param request - The request.
 * @returns The parsed request.
 * @throws EstimateError `request_invalid`.
 */
export function parseAgentRequest<T extends z.ZodType>(schema: T, request: unknown): z.output<T> {
  const parsed = schema.safeParse(request);
  if (!parsed.success) {
    throw new EstimateError(
      "request_invalid",
      `agent request refused: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
