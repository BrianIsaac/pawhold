import { eq } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Executor } from "@/db/client";
import { auditActor, practice } from "@/db/schema";
import { MAX_PENCE } from "@/money/currency";

import { currentPriceList } from "./price-list";
import { EstimateError } from "./errors";
import { caseEstimateVersions, loadEstimateVersion } from "./version";

/**
 * The Monetary Threshold by default: £500 including VAT, the CMA's figure
 * (plan 3.3). A practice may set its own; the database's default for
 * `practice.monetary_threshold_pence` is this figure too.
 */
export const DEFAULT_MONETARY_THRESHOLD_PENCE = 50_000;

/** The Order's percentage: an increase "by 20%". */
export const UPDATE_TRIGGER_PERCENT = 20;

const pence = z.int().nonnegative().max(MAX_PENCE);

const triggerInput = z.strictObject({
  originalPence: pence,
  revisedPence: pence,
  thresholdPence: pence.positive(),
});

export type UpdateTriggerInput = z.input<typeof triggerInput>;

/** Whether a revised estimate meets the Order's trigger for an updated written estimate. */
export interface UpdateTriggerCheck {
  /** The top of the original written estimate. */
  readonly originalPence: number;
  /** The top of the revised estimate. */
  readonly revisedPence: number;
  /** The revised less the original; negative for a decrease. */
  readonly increasePence: number;
  /**
   * The increase as a share of the original in basis points (2,000 is 20%),
   * rounded down; null when the original is nothing.
   */
  readonly increaseBasisPoints: number | null;
  readonly thresholdPence: number;
  /** The smallest increase that meets the trigger: the lower of 20% (to the whole penny up) and the threshold. */
  readonly triggerPence: number;
  readonly met: boolean;
}

/**
 * The Order's trigger, Art. 11: an updated written estimate is due when the
 * total estimated cost "is reasonably likely to increase, from the amount in
 * the original Written Estimate, by 20% or by an amount equal to the Monetary
 * Threshold, whichever is lower". An increase of exactly 20%, or of exactly
 * the threshold, meets it. The arithmetic is in whole pence, so 20% is
 * compared exactly (five times the increase against the original), never
 * through a rounded percentage.
 *
 * @param input - The original's and the revision's totals and the threshold, in pence.
 * @returns The check, with the increase and the amount that triggers.
 * @throws EstimateError when an amount is not whole, non-negative pence, or the threshold is nothing.
 */
export function checkUpdateTrigger(input: UpdateTriggerInput): UpdateTriggerCheck {
  const parsed = triggerInput.safeParse(input);
  if (!parsed.success) {
    throw new EstimateError(
      "request_invalid",
      `trigger check refused: ${z.prettifyError(parsed.error)}`,
    );
  }
  const { originalPence, revisedPence, thresholdPence } = parsed.data;
  const increasePence = revisedPence - originalPence;
  const twentyPercentPence = Math.ceil((originalPence * UPDATE_TRIGGER_PERCENT) / 100);
  const triggerPence = Math.max(1, Math.min(twentyPercentPence, thresholdPence));
  return {
    originalPence,
    revisedPence,
    increasePence,
    increaseBasisPoints:
      originalPence === 0 ? null : Math.floor((increasePence * 10_000) / originalPence),
    thresholdPence,
    triggerPence,
    met: increasePence >= triggerPence,
  };
}

/** The trigger check of one version against its case's original written estimate. */
export interface EstimateTriggerCheck extends UpdateTriggerCheck {
  /** The original written estimate: the case's first sent version. */
  readonly original: { readonly versionId: string; readonly number: number };
  readonly version: { readonly versionId: string; readonly number: number };
}

const versionTriggerRequest = z.strictObject({ practiceId: z.uuid(), versionId: z.uuid() });

/**
 * Checks a version against the Order's trigger: the top of its range against
 * the top of the case's original written estimate (the first version sent),
 * under the practice's threshold. The top of the range is the amount held
 * (D3), so the check is made on what the owner has authorised.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice and the version.
 * @returns The check, or null when the version is the original or no version before it was sent.
 * @throws EstimateError when the request is malformed or the practice has no such version.
 */
export async function checkEstimateTrigger(
  executor: Executor,
  request: z.input<typeof versionTriggerRequest>,
): Promise<EstimateTriggerCheck | null> {
  const parsed = versionTriggerRequest.safeParse(request);
  if (!parsed.success) {
    throw new EstimateError(
      "request_invalid",
      `trigger check refused: ${z.prettifyError(parsed.error)}`,
    );
  }
  const { practiceId, versionId } = parsed.data;
  const version = await loadEstimateVersion(executor, practiceId, versionId);
  if (!version) {
    throw new EstimateError(
      "version_not_found",
      `the practice has no estimate version ${versionId}`,
    );
  }
  const versions = await caseEstimateVersions(executor, practiceId, version.caseId);
  const original = versions.find((each) => each.sentAt !== null);
  if (!original || original.number >= version.number) {
    return null;
  }
  const check = checkUpdateTrigger({
    originalPence: original.totals.highPence,
    revisedPence: version.totals.highPence,
    thresholdPence: await monetaryThreshold(executor, practiceId),
  });
  return {
    ...check,
    original: { versionId: original.id, number: original.number },
    version: { versionId: version.id, number: version.number },
  };
}

/**
 * The practice's Monetary Threshold.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @returns The threshold in pence including VAT.
 * @throws EstimateError when there is no such practice.
 */
export async function monetaryThreshold(executor: Executor, practiceId: string): Promise<number> {
  const [found] = await executor
    .select({ pence: practice.monetaryThresholdPence })
    .from(practice)
    .where(eq(practice.id, practiceId));
  if (!found) {
    throw new EstimateError("request_invalid", `there is no practice ${practiceId}`);
  }
  return found.pence;
}

const thresholdRequest = z.strictObject({
  practiceId: z.uuid(),
  pence: pence.positive(),
  actor: z.enum(auditActor.enumValues),
});

/**
 * Sets the practice's Monetary Threshold and writes
 * `practice.threshold_changed` with the threshold before and after.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the threshold in pence including VAT, and who set it.
 * @returns Resolves once set.
 * @throws EstimateError when the threshold is not whole, positive pence, or there is no such practice.
 */
export async function setMonetaryThreshold(
  executor: Executor,
  request: z.input<typeof thresholdRequest>,
): Promise<void> {
  const parsed = thresholdRequest.safeParse(request);
  if (!parsed.success) {
    throw new EstimateError(
      "request_invalid",
      `threshold refused: ${z.prettifyError(parsed.error)}`,
    );
  }
  const { practiceId, pence: afterPence, actor } = parsed.data;
  await executor.transaction(async (tx) => {
    const [before] = await tx
      .select({ pence: practice.monetaryThresholdPence })
      .from(practice)
      .where(eq(practice.id, practiceId))
      .for("update");
    if (!before) {
      throw new EstimateError("request_invalid", `there is no practice ${practiceId}`);
    }
    await tx
      .update(practice)
      .set({ monetaryThresholdPence: afterPence })
      .where(eq(practice.id, practiceId));
    const list = await currentPriceList(tx, practiceId);
    await appendAuditEvent(tx, {
      practiceId,
      actor,
      action: "practice.threshold_changed",
      amount: { pence: afterPence, currency: list?.currencyCode ?? "GBP" },
      detail: { beforePence: before.pence, afterPence },
    });
  });
}
