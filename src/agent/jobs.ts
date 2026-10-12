import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import type { Executor, Transaction } from "@/db/client";
import { hold, patientCase } from "@/db/schema";
import {
  caseEstimateVersions,
  EstimateError,
  type EstimateLineInput,
  type EstimateVersionView,
  loadEstimateVersion,
  makeEstimateVersion,
  replaceDraftLines,
} from "@/estimate/version";

import type { AuditEventInput } from "@/audit/writer";
import { type CurrencyCode, currencyCode } from "@/money/currency";

import { type AskContext, type Asked, asJson } from "./ask";
import type { GuardedLines } from "./guardrails";
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
  readonly currencyCode: CurrencyCode;
  /** The draft open on the case, if any. */
  readonly open: EstimateVersionView | null;
  /** The last version sent to the owner, if any. */
  readonly lastSent: EstimateVersionView | null;
  /**
   * The last version the owner approved: one a hold was authorised for. An
   * update builds on it, never on an update the owner declined or that was
   * withdrawn (scope frozen at what is held, plan 3.2).
   */
  readonly lastApproved: EstimateVersionView | null;
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
 * Reads a case's estimate: its open draft and its last sent version. Inside
 * a transaction, `lock` holds the case's row until it ends, so two presses of
 * "Draft" at once write one after the other (a draft, then its redraft).
 *
 * @param db - The database or the open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @param lock - Whether to lock the case's row.
 * @returns The case's state.
 * @throws EstimateError `case_not_found` when the case is not the practice's.
 */
export async function caseEstimateState(
  db: Executor,
  practiceId: string,
  caseId: string,
  lock = false,
): Promise<CaseEstimateState> {
  const query = db
    .select({ patientName: patientCase.patientName, currencyCode: patientCase.currencyCode })
    .from(patientCase)
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));
  const [kase] = lock ? await query.for("update") : await query;
  if (!kase) {
    throw new EstimateError("case_not_found", `the practice has no case ${caseId}`);
  }
  const versions = await caseEstimateVersions(db, practiceId, caseId);
  const authorised = new Set(
    (
      await db
        .select({ id: hold.id })
        .from(hold)
        .where(and(eq(hold.caseId, caseId), isNotNull(hold.authorisedAt)))
    ).map((row) => row.id),
  );
  return {
    patientName: kase.patientName,
    currencyCode: currencyCode.parse(kase.currencyCode),
    open: versions.find((version) => version.sentAt === null) ?? null,
    lastSent: versions.filter((version) => version.sentAt !== null).at(-1) ?? null,
    lastApproved: versions.filter((version) => authorised.has(version.id)).at(-1) ?? null,
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

/** What an ask's audit event records beyond the ask itself. */
export interface AskAudit {
  readonly practiceId: string;
  readonly caseId: string;
  readonly action: "estimate.drafted" | "estimate.update_drafted";
  readonly modelId: string;
  readonly promptVersion: string;
  readonly asked: Asked<unknown>;
  readonly guarded: GuardedLines;
  /** The version written, or null when the write was refused. */
  readonly version: EstimateVersionView | null;
  /** Whether an open draft was left as it was because the model failed. */
  readonly preserved: boolean;
  /** Why the write was refused after the ask, or null. */
  readonly refused: string | null;
  /** The job's own fields for the output and the detail. */
  readonly output?: Record<string, unknown>;
  readonly detail?: Record<string, unknown>;
}

/**
 * The audit event of one ask (plan 3.5: for a model step, the model id, the
 * input's hash and the validated output), written for every ask: answered by
 * the model or the cache, capped, failed, or refused at the write.
 *
 * @param audit - The ask and what came of it.
 * @returns The event.
 */
export function askAuditEvent(audit: AskAudit): AuditEventInput {
  const { asked, guarded, version } = audit;
  return {
    practiceId: audit.practiceId,
    caseId: audit.caseId,
    actor: "system",
    action: audit.action,
    model: {
      id: audit.modelId,
      inputSha256: asked.hash,
      output: asJson({
        servedModel: asked.servedModel,
        answer: asked.answer,
        failure: asked.failure,
        kept: guarded.kept.map((kept) => kept.line.code),
        unmatched: guarded.unmatched,
        unsupported: guarded.unsupported,
        ...audit.output,
      }),
    },
    detail: asJson({
      versionId: version?.id ?? null,
      number: version?.number ?? null,
      promptVersion: audit.promptVersion,
      source: asked.source,
      draftedLines: guarded.kept.length,
      versionLines: version?.lines.length ?? null,
      preserved: audit.preserved,
      unmatchedCount: guarded.unmatched.length,
      unsupportedCount: guarded.unsupported.length,
      failure: asked.failure?.reason ?? null,
      refused: audit.refused,
      ...audit.detail,
    }) as Record<string, z.core.util.JSONType>,
  };
}
