import { eq } from "drizzle-orm";

import type { AuditEventInput } from "@/audit/writer";
import type { Transaction } from "@/db/client";
import { estimateLine, estimateSource, estimateVersion } from "@/db/schema";
import type { PriceListWithItems } from "@/estimate/price-list";
import { estimateLineInput, type EstimateLineInput } from "@/estimate/version";

/*
 * The seeds' one writer of a sent estimate version and its events (U11 folded
 * the three copies U5's showcase case, U8a's day and U9's showcase each
 * kept): rows the database checks, written as U2, U3 and U5 write them.
 */

/** One line the seed wrote, as a bill or a hold reads it. */
export interface SeededLine {
  readonly id: string;
  readonly code: string;
  readonly unitPricePence: number;
  readonly highPence: number;
}

/** A version the seed wrote, as its events and its hold name it. */
export interface SeededVersion {
  readonly id: string;
  readonly number: number;
  readonly currency: PriceListWithItems["currencyCode"];
  readonly priceListId: string;
  readonly lowPence: number;
  readonly highPence: number;
  readonly lines: readonly SeededLine[];
}

/** An audit event the seed writes, before its practice and case are given. */
export type SeededEvent = Omit<AuditEventInput, "practiceId" | "caseId">;

/**
 * Writes one version as a draft with its lines and its source, then sends it,
 * as U2 does: the database checks the sent totals against the lines.
 *
 * @param tx - The transaction.
 * @param write - The version's practice, case, list, number, lines, source and times.
 * @param write.practiceId - The practice.
 * @param write.caseId - The case.
 * @param write.list - The price list it is priced from.
 * @param write.number - Its number.
 * @param write.lines - Its lines.
 * @param write.source - The words it was drafted from.
 * @param write.source.kind - Notes or a finding.
 * @param write.source.text - The words.
 * @param write.source.explanation - The owner's explanation of an update.
 * @param write.madeAt - When it was made.
 * @param write.sentAt - When it was sent.
 * @returns The version.
 * @throws Error when a line's item is not on the list.
 */
export async function writeSentVersion(
  tx: Transaction,
  write: {
    practiceId: string;
    caseId: string;
    list: PriceListWithItems;
    number: number;
    lines: readonly EstimateLineInput[];
    source: { kind: "notes" | "finding"; text: string; explanation: string | null };
    madeAt: Date;
    sentAt: Date;
  },
): Promise<SeededVersion> {
  const priced = write.lines.map((given) => {
    const line = estimateLineInput.parse(given);
    const item = write.list.items.get(line.code);
    if (!item) {
      throw new Error(`the seed's ${line.code} is not on the practice's price list`);
    }
    return { line, item };
  });
  const [version] = await tx
    .insert(estimateVersion)
    .values({
      practiceId: write.practiceId,
      caseId: write.caseId,
      priceListId: write.list.id,
      number: write.number,
      createdAt: write.madeAt,
    })
    .returning({ id: estimateVersion.id });
  const versionId = version!.id;
  const stored = await tx
    .insert(estimateLine)
    .values(
      priced.map(({ line, item }, at) => ({
        versionId,
        priceListId: write.list.id,
        position: at + 1,
        priceListItemId: item.id,
        unitPricePence: item.unitPricePence,
        quantityLow: line.quantityLow,
        quantityHigh: line.quantityHigh,
        dependsOn: line.dependsOn ?? null,
        notesSpan: line.notesSpan ?? null,
        ownerWording: line.ownerWording ?? null,
      })),
    )
    .returning({ id: estimateLine.id, position: estimateLine.position });
  await tx.insert(estimateSource).values({
    versionId,
    practiceId: write.practiceId,
    caseId: write.caseId,
    kind: write.source.kind,
    text: write.source.text,
    explanation: write.source.explanation,
    createdAt: write.madeAt,
    updatedAt: write.madeAt,
  });
  const lowPence = priced.reduce(
    (sum, { line, item }) => sum + item.unitPricePence * line.quantityLow,
    0,
  );
  const highPence = priced.reduce(
    (sum, { line, item }) => sum + item.unitPricePence * line.quantityHigh,
    0,
  );
  await tx
    .update(estimateVersion)
    .set({ sentAt: write.sentAt, totalLowPence: lowPence, totalHighPence: highPence })
    .where(eq(estimateVersion.id, versionId));
  const idAt = new Map(stored.map((row) => [row.position, row.id]));
  return {
    id: versionId,
    number: write.number,
    currency: write.list.currencyCode,
    priceListId: write.list.id,
    lowPence,
    highPence,
    lines: priced.map(({ line, item }, at) => ({
      id: idAt.get(at + 1)!,
      code: line.code,
      unitPricePence: item.unitPricePence,
      highPence: item.unitPricePence * line.quantityHigh,
    })),
  };
}

/**
 * `estimate.version_made`, as U2 writes it.
 *
 * @param version - The version.
 * @returns The event.
 */
export function versionMade(version: SeededVersion): SeededEvent {
  return {
    actor: "vet",
    action: "estimate.version_made",
    detail: {
      versionId: version.id,
      number: version.number,
      priceListId: version.priceListId,
      lineCount: version.lines.length,
      lowPence: version.lowPence,
      highPence: version.highPence,
    },
  };
}

/**
 * `estimate.approved`, the vet's approval with the vet's name, as U5 writes it.
 *
 * @param version - The version.
 * @param vetName - The vet.
 * @returns The event.
 */
export function approved(version: SeededVersion, vetName: string): SeededEvent {
  return {
    actor: "vet",
    action: "estimate.approved",
    detail: {
      versionId: version.id,
      number: version.number,
      vetName,
      lowPence: version.lowPence,
      highPence: version.highPence,
      lineCount: version.lines.length,
    },
  };
}

/**
 * `estimate.sent` with the states before and after, as U3 writes it.
 *
 * @param version - The version.
 * @param before - The case's state before.
 * @param after - The case's state after.
 * @returns The event.
 */
export function sent(
  version: SeededVersion,
  before: "estimate_draft" | "held",
  after: "awaiting_owner" | "update_awaiting_owner",
): SeededEvent {
  return {
    actor: "vet",
    action: "estimate.sent",
    moneyStateBefore: before,
    moneyStateAfter: after,
    amount: { pence: version.highPence, currency: version.currency },
    detail: {
      versionId: version.id,
      number: version.number,
      lowPence: version.lowPence,
      highPence: version.highPence,
    },
  };
}
