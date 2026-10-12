import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Executor } from "@/db/client";
import { currentPriceList, type PriceListWithItems } from "@/estimate/price-list";
import { EstimateError, type EstimateVersionView } from "@/estimate/version";

import { type AskFailure, askModel } from "./ask";
import {
  guardLines,
  type GuardedLines,
  type OwnerWordingFault,
  type UnmatchedSpan,
  type UnsupportedLine,
} from "./guardrails";
import {
  type AgentDependencies,
  askAuditEvent,
  askContext,
  type CaseEstimateState,
  caseEstimateState,
  parseAgentRequest,
  writeDraft,
} from "./jobs";
import type { ModelRequest } from "./model";
import { DRAFT_PROMPT_VERSION, draftInstructions } from "./prompts/draft";
import type { PromptItem } from "./prompts/price-list";
import { DRAFT_FORMAT } from "./schema";

/** The longest notes a draft reads. */
export const MAX_NOTES_LENGTH = 10_000;

export type { AgentDependencies } from "./jobs";

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
  /** Why the line's condition fell back to the vet's words, or null. */
  readonly dependsOnFellBack: OwnerWordingFault | null;
}

/** A draft as the vet's screen shows it. */
export interface DraftedEstimate {
  /**
   * The draft version: the kept lines, priced from the list. On a model
   * failure, an empty first draft, or the open draft as it was.
   */
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
 * Drafts a case's estimate from the vet's notes (plan 3.4, job 1): asks for
 * lines under the strict schema (from the practice's draft cache when the same
 * notes and list were drafted before, never past the practice's hourly cap,
 * D8), runs the guardrails, and writes the lines that pass, priced by U2 from
 * the practice's list, as the case's first version, a draft; pressing "Draft"
 * again redrafts the open draft. A model failure leaves an empty draft the vet
 * fills by hand (or an open draft as it was). The draft and its
 * `estimate.drafted` audit event, with the model id, the input's hash, the
 * validated output and where the answer came from, commit together. Nothing
 * is sent to the owner: the vet reviews and sends.
 *
 * @param dependencies - The database, the model and the cap.
 * @param request - The practice, the case and the notes.
 * @returns The draft, its spans, what was unmatched or left out, and any failure.
 * @throws EstimateError when the request is malformed, the case is not the
 *   practice's, its estimate was sent (an update changes it), or the practice
 *   has no price list in the case's currency, each before the model is asked;
 *   or when the write is refused after the ask (the draft was sent
 *   meanwhile), the ask then audited with why.
 */
export async function draftEstimate(
  dependencies: AgentDependencies,
  request: DraftEstimateRequest,
): Promise<DraftedEstimate> {
  const { practiceId, caseId, notes } = parseAgentRequest(draftRequestInput, request);
  const { db, model } = dependencies;
  refuseIfSent(await caseEstimateState(db, practiceId, caseId));
  const list = await draftableList(db, practiceId, caseId);

  const modelRequest = draftRequest(list.items.values(), notes);
  const asked = await askModel(askContext(dependencies, practiceId), modelRequest, draftEnvelope);
  const guard = (items: PriceListWithItems["items"]): GuardedLines =>
    asked.answer ? guardLines(asked.answer.lines, asked.answer.unmatched, notes, items) : NOTHING;
  const audit = {
    practiceId,
    caseId,
    action: "estimate.drafted",
    modelId: model.settings.model,
    promptVersion: DRAFT_PROMPT_VERSION,
    asked,
  } as const;

  try {
    return await db.transaction(async (tx) => {
      const state = await caseEstimateState(tx, practiceId, caseId, true);
      refuseIfSent(state);
      const current = (await currentPriceList(tx, practiceId)) ?? list;
      const guarded = guard(current.items);
      const failed = asked.failure !== null;
      const version = await writeDraft(tx, {
        practiceId,
        caseId,
        open: state.open,
        lines: guarded.kept.map((kept) => kept.line),
        failed,
      });
      await appendAuditEvent(
        tx,
        askAuditEvent({
          ...audit,
          guarded,
          version,
          preserved: failed && state.open !== null,
          refused: null,
        }),
      );
      return {
        version,
        lines: guarded.kept.map((kept, at) => ({
          position: at + 1,
          start: kept.start,
          end: kept.end,
          ownerWordingFellBack: kept.ownerWordingFellBack,
          dependsOnFellBack: kept.dependsOnFellBack,
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
  } catch (error) {
    if (error instanceof EstimateError) {
      await appendAuditEvent(
        db,
        askAuditEvent({
          ...audit,
          guarded: guard(list.items),
          version: null,
          preserved: false,
          refused: error.reason,
        }),
      );
    }
    throw error;
  }
}

/**
 * Refuses a draft once the estimate has been sent: an update changes it.
 *
 * @param state - The case's estimate.
 * @throws EstimateError `sent`.
 */
function refuseIfSent(state: CaseEstimateState): void {
  if (state.lastSent) {
    throw new EstimateError(
      "sent",
      `version ${state.lastSent.number} of this estimate was sent; draft an update to change it`,
    );
  }
}

/**
 * The practice's current price list, refused before the model is asked when
 * there is none or its currency is not the case's.
 *
 * @param db - The database.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The list.
 * @throws EstimateError `no_price_list` or `currency_mismatch`.
 */
export async function draftableList(
  db: Executor,
  practiceId: string,
  caseId: string,
): Promise<PriceListWithItems> {
  const state = await caseEstimateState(db, practiceId, caseId);
  const list = await currentPriceList(db, practiceId);
  if (!list) {
    throw new EstimateError("no_price_list", "the practice has no price list to draft from");
  }
  if (list.currencyCode !== state.currencyCode) {
    throw new EstimateError(
      "currency_mismatch",
      `the case is in ${state.currencyCode}, the price list in ${list.currencyCode}`,
    );
  }
  return list;
}
