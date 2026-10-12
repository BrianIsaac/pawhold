import { and, eq } from "drizzle-orm";

import type { Executor } from "@/db/client";
import { patientCase, practice } from "@/db/schema";
import type { PenceRange } from "@/estimate/version";
import { loadEstimateVersion } from "@/estimate/version";
import type { CurrencyCode } from "@/money/currency";
import type { MoneyState } from "@/money/state";
import { caseHolds, type HoldView } from "@/money/view";

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

/** What an owner's link opens, as its page shows it. */
export type OwnerPage = {
  readonly kind: "estimate";
  readonly header: OwnerCaseHeader;
  readonly state: MoneyState;
  readonly currency: CurrencyCode;
  readonly versionId: string;
  readonly lines: readonly OwnerLine[];
  readonly totals: PenceRange;
  /** What authorising holds: the top of the range (D3). */
  readonly holdPence: number;
  /** The version's hold, once the owner's page has asked for its order. */
  readonly hold: HoldView | null;
};

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
 * The page an owner's link opens for its case and sent version.
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
  return {
    kind: "estimate",
    header: found.header,
    state: found.state,
    currency: version.currency,
    versionId: version.id,
    lines: version.lines.map((line) => ({
      position: line.position,
      wording: line.ownerWording ?? line.name,
      notesSpan: line.notesSpan,
      dependsOn: line.dependsOn,
      lowPence: line.lowPence,
      highPence: line.highPence,
    })),
    totals: version.totals,
    holdPence: version.totals.highPence,
    hold: holds.find((one) => one.id === version.id) ?? null,
  };
}
