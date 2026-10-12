import { and, desc, eq, isNotNull, max, sql } from "drizzle-orm";

import type { Executor } from "@/db/client";
import { auditEvent, estimateVersion, patientCase, practice } from "@/db/schema";
import {
  estimateDelta,
  type EstimateLineView,
  type EstimateVersionView,
  loadEstimateVersion,
  type PenceRange,
} from "@/estimate/version";
import type { CurrencyCode } from "@/money/currency";
import type { MoneyState } from "@/money/state";
import { caseHolds, type HoldView, updateIncrease } from "@/money/view";

/** Who a case is for and who sent it, as the owner's pages name them. */
export interface OwnerCaseHeader {
  readonly practiceName: string;
  readonly patientName: string;
  readonly ownerName: string;
}

/** One line of an estimate as the owner reads it. */
export interface OwnerLine extends PenceRange {
  readonly position: number;
  /** The owner's wording, or the price list's name where the vet gave none. */
  readonly wording: string;
  /** The words of the vet's notes the line came from ("What the vet wrote"). */
  readonly notesSpan: string | null;
  /** The finding the line depends on ("Only if: ..."). */
  readonly dependsOn: string | null;
}

/** What every owner's page for a sent version knows. */
interface OwnerVersionPage {
  readonly header: OwnerCaseHeader;
  readonly state: MoneyState;
  readonly currency: CurrencyCode;
  readonly versionId: string;
  /** Whether this version is the latest the practice sent (an older link's version is not). */
  readonly isLatest: boolean;
  /** The version's hold, once the owner's page has asked for its order. */
  readonly hold: HoldView | null;
}

/** The first estimate: what the owner is asked to authorise (section 6). */
export interface OwnerEstimatePage extends OwnerVersionPage {
  readonly kind: "estimate";
  readonly lines: readonly OwnerLine[];
  readonly totals: PenceRange;
  /** What authorising holds: the top of the range (D3). */
  readonly holdPence: number;
}

/** An update: what the vet found and what it adds over what is held (section 6). */
export interface OwnerUpdatePage extends OwnerVersionPage {
  readonly kind: "update";
  /** U4's explanation for the owner, checked by code; null when withheld or drafted by hand. */
  readonly explanation: string | null;
  /** The lines the update adds or raises, in the owner's words, at this version's amounts. */
  readonly added: readonly OwnerLine[];
  /** What the case's holds held before this update. */
  readonly heldPence: number;
  /** What approving holds: the version's top less what was held (U3's decision 2). */
  readonly increasePence: number;
}

/** What an owner's link opens, as its page shows it. */
export type OwnerPage = OwnerEstimatePage | OwnerUpdatePage;

/** A hold's statuses once it held the owner's money. */
const HELD_ONCE: ReadonlySet<HoldView["status"]> = new Set([
  "authorised",
  "captured",
  "voided",
  "expired",
]);

/** The case and the sent version a link opens. */
export interface OwnerPageRequest {
  readonly practiceId: string;
  readonly caseId: string;
  readonly versionId: string;
}

/**
 * The names an owner's page heads with.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The names and the case's money state, or null when the practice has no such case.
 */
async function caseHeader(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<{ header: OwnerCaseHeader; state: MoneyState } | null> {
  const [found] = await executor
    .select({
      practiceName: practice.name,
      patientName: patientCase.patientName,
      ownerName: patientCase.ownerName,
      state: patientCase.moneyState,
    })
    .from(patientCase)
    .innerJoin(practice, eq(practice.id, patientCase.practiceId))
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));
  if (!found) {
    return null;
  }
  const { state, ...header } = found;
  return { header, state };
}

/**
 * The page an owner's link opens for its case and sent version: the first
 * estimate, or an update when an earlier version of the case held money.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the case and the version, as the link resolved.
 * @returns The page, or null when the practice's case has no such sent version.
 */
export async function ownerPage(
  executor: Executor,
  request: OwnerPageRequest,
): Promise<OwnerPage | null> {
  const found = await caseHeader(executor, request.practiceId, request.caseId);
  const version = await loadEstimateVersion(executor, request.practiceId, request.versionId);
  if (!found || !version || version.caseId !== request.caseId || version.sentAt === null) {
    return null;
  }
  const holds = await caseHolds(executor, request.caseId);
  const base = {
    header: found.header,
    state: found.state,
    currency: version.currency,
    versionId: version.id,
    isLatest: await isLatestSent(executor, version),
    hold: holds.find((one) => one.id === version.id) ?? null,
  };
  const earlier = holds.filter(
    (one) => one.versionNumber < version.number && HELD_ONCE.has(one.status),
  );
  if (earlier.length === 0) {
    return {
      kind: "estimate",
      ...base,
      lines: version.lines.map(ownerLine),
      totals: version.totals,
      holdPence: version.totals.highPence,
    };
  }

  const previous = await loadEstimateVersion(executor, request.practiceId, earlier.at(-1)!.id);
  const changed = new Set(
    estimateDelta(previous!, version)
      .items.filter((item) => item.change !== "removed")
      .map((item) => item.code),
  );
  const { heldPence, increasePence } = base.hold
    ? { heldPence: base.hold.heldBeforePence, increasePence: base.hold.amount.pence }
    : await updateIncrease(executor, request.practiceId, version.id);
  return {
    kind: "update",
    ...base,
    explanation: await updateExplanation(executor, version.caseId, version.id),
    added: version.lines.filter((line) => changed.has(line.code)).map(ownerLine),
    heldPence,
    increasePence,
  };
}

/**
 * A version's line as the owner reads it.
 *
 * @param line - The priced line.
 * @returns The owner's line.
 */
function ownerLine(line: EstimateLineView): OwnerLine {
  return {
    position: line.position,
    wording: line.ownerWording ?? line.name,
    notesSpan: line.notesSpan,
    dependsOn: line.dependsOn,
    lowPence: line.lowPence,
    highPence: line.highPence,
  };
}

/**
 * Whether a version is the latest the practice sent of its case.
 *
 * @param executor - The pool or an open transaction.
 * @param version - The version.
 * @returns True when no later version was sent.
 */
async function isLatestSent(executor: Executor, version: EstimateVersionView): Promise<boolean> {
  const [latest] = await executor
    .select({ number: max(estimateVersion.number) })
    .from(estimateVersion)
    .where(and(eq(estimateVersion.caseId, version.caseId), isNotNull(estimateVersion.sentAt)));
  return (latest?.number ?? version.number) === version.number;
}

/**
 * U4's explanation of an update for its owner: the checked explanation of
 * the latest `estimate.update_drafted` event that made this version (U4's
 * finding 7: it is kept nowhere else). Null when U4 withheld it, or the
 * update was drafted by hand.
 *
 * @param executor - The pool or an open transaction.
 * @param caseId - The case.
 * @param versionId - The update's version.
 * @returns The explanation, or null.
 */
async function updateExplanation(
  executor: Executor,
  caseId: string,
  versionId: string,
): Promise<string | null> {
  const [drafted] = await executor
    .select({ output: auditEvent.modelOutput })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.caseId, caseId),
        eq(auditEvent.action, "estimate.update_drafted"),
        sql`${auditEvent.detail} ->> 'versionId' = ${versionId}`,
      ),
    )
    .orderBy(desc(auditEvent.id))
    .limit(1);
  const explanation = (drafted?.output as { explanation?: unknown } | null | undefined)
    ?.explanation;
  return typeof explanation === "string" && explanation.trim().length > 0 ? explanation : null;
}
