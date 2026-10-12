import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import { patientCase } from "@/db/schema";
import { currentPriceList } from "@/estimate/price-list";
import {
  caseEstimateVersions,
  type EstimateDelta,
  estimateDelta,
  EstimateError,
  type EstimateVersionView,
  linesOf,
  makeEstimateVersion,
} from "@/estimate/version";

import { type AskFailure, askModel, asJson } from "./ask";
import {
  checkExplanation,
  type ExplanationFault,
  guardLines,
  type GuardedLines,
  type UnmatchedSpan,
  type UnsupportedLine,
} from "./guardrails";
import {
  type AgentDependencies,
  assertDraftable,
  type DraftedLineNote,
  parseAgentRequest,
} from "./draft";
import type { ModelImage, ModelRequest } from "./model";
import type { PromptItem } from "./prompts/price-list";
import { UPDATE_PROMPT_VERSION, updateInstructions } from "./prompts/update";
import { UPDATE_FORMAT } from "./schema";

/** The longest finding an update reads. */
export const MAX_FINDING_LENGTH = 5_000;

/** The largest photo sent with an update: 5 MiB, as base64 about 6.7 million characters. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** What {@link draftUpdate} takes. */
export interface DraftUpdateRequest {
  readonly practiceId: string;
  readonly caseId: string;
  /** The vet's words: what was found and what is recommended. */
  readonly finding: string;
  /** An optional photo (D12: an illustration in the demo). */
  readonly photo: ModelImage | null;
}

/** An update as the vet's screen and the owner's page show it. */
export interface DraftedUpdate {
  /** The sent version the update changes. */
  readonly basedOn: EstimateVersionView;
  /** The new draft version: the sent lines and the delta lines, priced from the list. */
  readonly version: EstimateVersionView;
  /** What changed from the sent version, by item. */
  readonly delta: EstimateDelta;
  /** For each delta line, where its span sits in the vet's finding. */
  readonly lines: readonly DraftedLineNote[];
  readonly unmatched: readonly UnmatchedSpan[];
  readonly unsupported: readonly UnsupportedLine[];
  /** The owner's explanation, checked; null when it failed a check or the model failed. */
  readonly explanation: string | null;
  /** Why the explanation is not shown, or null. */
  readonly explanationFellBack: ExplanationFault | null;
  /** The vet's own words, which the owner can always read. */
  readonly vetNote: string;
  readonly failure: AskFailure | null;
  readonly model: {
    readonly id: string;
    readonly servedModel: string | null;
    readonly inputSha256: string;
    readonly promptVersion: string;
  };
}

/** What an update's model request is made from. */
export interface UpdateRequestParts {
  readonly items: Iterable<PromptItem>;
  readonly patientName: string;
  readonly basedOn: EstimateVersionView;
  readonly finding: string;
  readonly photo: ModelImage | null;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const updateRequestInput = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  finding: z
    .string()
    .max(MAX_FINDING_LENGTH)
    .refine((finding) => finding.trim().length > 0, "the finding is empty"),
  photo: z
    .strictObject({
      mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
      dataBase64: z
        .string()
        .min(4)
        .max(Math.ceil(MAX_PHOTO_BYTES / 3) * 4)
        .refine((data) => data.length % 4 === 0 && BASE64.test(data), "the photo is not base64"),
    })
    .nullable(),
});

const updateEnvelope = z.strictObject({
  lines: z.array(z.unknown()),
  explanation: z.string(),
});

const NOTHING: GuardedLines = { kept: [], unmatched: [], unsupported: [] };

/**
 * The model request for an update: the prompt and the price list as the
 * instructions; the patient, the sent estimate's lines and the vet's finding
 * as the input; the photo beside them.
 *
 * @param parts - The price list, the patient, the sent version, the finding and the photo.
 * @returns The request.
 */
export function updateRequest(parts: UpdateRequestParts): ModelRequest {
  const sentLines = parts.basedOn.lines.map(
    (line) =>
      `${line.code} | ${line.name} | ${line.quantityLow === line.quantityHigh ? line.quantityHigh : `${line.quantityLow} to ${line.quantityHigh}`} ${line.unit}`,
  );
  const input = [
    `Patient: ${parts.patientName}`,
    "",
    `The estimate sent to the owner (version ${parts.basedOn.number}), code | name | quantity:`,
    ...sentLines,
    "",
    "The vet's finding and recommendation:",
    parts.finding,
  ].join("\n");
  return {
    job: "update",
    promptVersion: UPDATE_PROMPT_VERSION,
    instructions: updateInstructions(parts.items),
    input,
    image: parts.photo,
    format: UPDATE_FORMAT,
  };
}

/**
 * Drafts an update to a case's sent estimate from the vet's finding and an
 * optional photo (plan 3.4, job 2): the delta lines under the same guardrails
 * as a draft, their spans checked against the vet's finding only, and a short
 * explanation for the owner that is shown only if it passes its checks. The
 * new version, a draft, holds the sent lines and the delta lines; a model
 * failure leaves the sent lines alone for the vet to add to by hand. The
 * version and its `estimate.update_drafted` audit event commit together; the
 * photo's hash, type and size are recorded, never the photo.
 *
 * @param dependencies - The database and the model.
 * @param request - The practice, the case, the finding and the photo.
 * @returns The update.
 * @throws EstimateError when the request is malformed, the case is not the
 *   practice's, a draft is open, the case has no sent estimate, or the
 *   practice has no price list; each before the model is asked.
 */
export async function draftUpdate(
  dependencies: AgentDependencies,
  request: DraftUpdateRequest,
): Promise<DraftedUpdate> {
  const { practiceId, caseId, finding, photo } = parseAgentRequest(updateRequestInput, request);
  const { db, model } = dependencies;
  await assertDraftable(db, practiceId, caseId);
  const basedOn = (await caseEstimateVersions(db, practiceId, caseId))
    .filter((version) => version.sentAt !== null)
    .at(-1);
  if (!basedOn) {
    throw new EstimateError("version_not_found", "the case has no sent estimate to update");
  }
  const list = await currentPriceList(db, practiceId);
  if (!list) {
    throw new EstimateError("no_price_list", "the practice has no price list to draft from");
  }
  const [kase] = await db
    .select({ patientName: patientCase.patientName })
    .from(patientCase)
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));

  const modelRequest = updateRequest({
    items: list.items.values(),
    patientName: kase!.patientName,
    basedOn,
    finding,
    photo,
  });
  const asked = await askModel(model, modelRequest, updateEnvelope);

  return db.transaction(async (tx) => {
    const current = (await currentPriceList(tx, practiceId)) ?? list;
    const guarded = asked.answer
      ? guardLines(asked.answer.lines, [], finding, current.items)
      : NOTHING;
    const explanationFellBack = asked.answer
      ? checkExplanation(asked.answer.explanation, finding)
      : null;
    const explanation =
      asked.answer && explanationFellBack === null ? asked.answer.explanation.trim() : null;
    const version = await makeEstimateVersion(tx, {
      practiceId,
      caseId,
      actor: "system",
      lines: [...linesOf(basedOn), ...guarded.kept.map((kept) => kept.line)],
    });
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: "system",
      action: "estimate.update_drafted",
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
          explanation,
          explanationFellBack,
        }),
      },
      detail: {
        versionId: version.id,
        number: version.number,
        basedOnVersionId: basedOn.id,
        promptVersion: UPDATE_PROMPT_VERSION,
        source: "model",
        photo: photo
          ? {
              mediaType: photo.mediaType,
              sha256: createHash("sha256")
                .update(Buffer.from(photo.dataBase64, "base64"))
                .digest("hex"),
              bytes: Buffer.from(photo.dataBase64, "base64").length,
            }
          : null,
        lineCount: guarded.kept.length,
        failure: asked.failure?.reason ?? null,
      },
    });
    const offset = basedOn.lines.length;
    return {
      basedOn,
      version,
      delta: estimateDelta(basedOn, version),
      lines: guarded.kept.map((kept, at) => ({
        position: offset + at + 1,
        start: kept.start,
        end: kept.end,
        ownerWordingFellBack: kept.ownerWordingFellBack,
      })),
      unmatched: guarded.unmatched,
      unsupported: guarded.unsupported,
      explanation,
      explanationFellBack,
      vetNote: finding,
      failure: asked.failure,
      model: {
        id: model.settings.model,
        servedModel: asked.servedModel,
        inputSha256: asked.hash,
        promptVersion: UPDATE_PROMPT_VERSION,
      },
    };
  });
}
