import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Executor } from "@/db/client";
import { estimateVersion, patientCase } from "@/db/schema";
import { currentPriceList } from "@/estimate/price-list";
import { EstimateError, type EstimateVersionView, makeEstimateVersion } from "@/estimate/version";

import { type AskFailure, askModel, asJson } from "./ask";
import {
  guardLines,
  type GuardedLines,
  type OwnerWordingFault,
  type UnmatchedSpan,
  type UnsupportedLine,
} from "./guardrails";
import type { DraftModel, ModelRequest } from "./model";
import { DRAFT_PROMPT_VERSION, draftInstructions } from "./prompts/draft";
import type { PromptItem } from "./prompts/price-list";
import { DRAFT_FORMAT } from "./schema";

/** The longest notes a draft reads. */
export const MAX_NOTES_LENGTH = 10_000;

/** What the agent's jobs are given: the database and the model. */
export interface AgentDependencies {
  readonly db: Executor;
  readonly model: DraftModel;
}

/** What {@link draftEstimate} takes. */
export interface DraftEstimateRequest {
  readonly practiceId: string;
  readonly caseId: string;
  /** The vet's admission notes, as typed or pasted. */
  readonly notes: string;
}

/** Where a drafted line's span sits in the notes, and whether its wording fell back. */
export interface DraftedLineNote {
  /** The line's position in the version (the first is 1). */
  readonly position: number;
  readonly start: number;
  readonly end: number;
  readonly ownerWordingFellBack: OwnerWordingFault | null;
}

/** A draft as the vet's screen shows it. */
export interface DraftedEstimate {
  /** The draft version: the kept lines, priced from the list; empty on a model failure. */
  readonly version: EstimateVersionView;
  /** For each of the version's lines, in order, where its span sits. */
  readonly lines: readonly DraftedLineNote[];
  /** Spans no price list item matched: "add one by hand or leave it out". */
  readonly unmatched: readonly UnmatchedSpan[];
  /** Lines left out: their span is not in the notes, or they were malformed. */
  readonly unsupported: readonly UnsupportedLine[];
  /** Why the model gave nothing usable, or null. */
  readonly failure: AskFailure | null;
  readonly model: {
    readonly id: string;
    readonly servedModel: string | null;
    readonly inputSha256: string;
    readonly promptVersion: string;
  };
}

const draftRequestInput = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  notes: z
    .string()
    .max(MAX_NOTES_LENGTH)
    .refine((notes) => notes.trim().length > 0, "the notes are empty"),
});

const draftEnvelope = z.strictObject({
  lines: z.array(z.unknown()),
  unmatched: z.array(z.unknown()),
});

const NOTHING: GuardedLines = { kept: [], unmatched: [], unsupported: [] };

/**
 * The model request for a draft: the prompt and the price list as the
 * instructions, the notes as the input.
 *
 * @param items - The practice's price list items.
 * @param notes - The vet's notes.
 * @returns The request.
 */
export function draftRequest(items: Iterable<PromptItem>, notes: string): ModelRequest {
  return {
    job: "draft",
    promptVersion: DRAFT_PROMPT_VERSION,
    instructions: draftInstructions(items),
    input: notes,
    image: null,
    format: DRAFT_FORMAT,
  };
}

/**
 * Drafts a case's estimate from the vet's notes (plan 3.4, job 1): asks the
 * model for lines under the strict schema, runs the guardrails, and makes the
 * case's next version, a draft, from the lines that pass, priced by U2 from
 * the practice's list. A model failure makes an empty draft the vet fills by
 * hand. The draft and its `estimate.drafted` audit event, with the model id,
 * the input's hash and the validated output, commit together. Nothing is sent
 * to the owner: the vet reviews and sends.
 *
 * @param dependencies - The database and the model.
 * @param request - The practice, the case and the notes.
 * @returns The draft, its spans, what was unmatched or left out, and any failure.
 * @throws EstimateError when the request is malformed, the case is not the
 *   practice's, a draft is already open, or the practice has no price list;
 *   each before the model is asked.
 */
export async function draftEstimate(
  dependencies: AgentDependencies,
  request: DraftEstimateRequest,
): Promise<DraftedEstimate> {
  const { practiceId, caseId, notes } = parseAgentRequest(draftRequestInput, request);
  const { db, model } = dependencies;
  await assertDraftable(db, practiceId, caseId);
  const list = await currentPriceList(db, practiceId);
  if (!list) {
    throw new EstimateError("no_price_list", "the practice has no price list to draft from");
  }

  const modelRequest = draftRequest(list.items.values(), notes);
  const asked = await askModel(model, modelRequest, draftEnvelope);

  return db.transaction(async (tx) => {
    const current = (await currentPriceList(tx, practiceId)) ?? list;
    const guarded = asked.answer
      ? guardLines(asked.answer.lines, asked.answer.unmatched, notes, current.items)
      : NOTHING;
    const version = await makeEstimateVersion(tx, {
      practiceId,
      caseId,
      actor: "system",
      lines: guarded.kept.map((kept) => kept.line),
    });
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: "system",
      action: "estimate.drafted",
      model: {
        id: model.settings.model,
        inputSha256: asked.hash,
        output: asJson({
          servedModel: asked.servedModel,
          answer: asked.answer,
          failure: asked.failure,
          kept: guarded.kept.map((kept) => kept.line.code),
          unmatched: guarded.unmatched,
          unsupported: guarded.unsupported,
        }),
      },
      detail: {
        versionId: version.id,
        number: version.number,
        promptVersion: DRAFT_PROMPT_VERSION,
        source: "model",
        lineCount: guarded.kept.length,
        unmatchedCount: guarded.unmatched.length,
        unsupportedCount: guarded.unsupported.length,
        failure: asked.failure?.reason ?? null,
      },
    });
    return {
      version,
      lines: guarded.kept.map((kept, at) => ({
        position: at + 1,
        start: kept.start,
        end: kept.end,
        ownerWordingFellBack: kept.ownerWordingFellBack,
      })),
      unmatched: guarded.unmatched,
      unsupported: guarded.unsupported,
      failure: asked.failure,
      model: {
        id: model.settings.model,
        servedModel: asked.servedModel,
        inputSha256: asked.hash,
        promptVersion: DRAFT_PROMPT_VERSION,
      },
    };
  });
}

/**
 * Refuses, before the model is asked, a case that is not the practice's or
 * already has a draft open.
 *
 * @param db - The database.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @throws EstimateError `case_not_found` or `draft_exists`.
 */
export async function assertDraftable(
  db: Executor,
  practiceId: string,
  caseId: string,
): Promise<void> {
  const [kase] = await db
    .select({ id: patientCase.id })
    .from(patientCase)
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));
  if (!kase) {
    throw new EstimateError("case_not_found", `the practice has no case ${caseId}`);
  }
  const [open] = await db
    .select({ number: estimateVersion.number })
    .from(estimateVersion)
    .where(and(eq(estimateVersion.caseId, caseId), isNull(estimateVersion.sentAt)));
  if (open) {
    throw new EstimateError(
      "draft_exists",
      `version ${open.number} of this estimate is a draft; change it or send it first`,
    );
  }
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
