import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { Executor } from "@/db/client";
import { bill, billLine, estimateLine, patientCase, priceListItem } from "@/db/schema";
import { currentPriceList, priceListCode } from "@/estimate/price-list";
import {
  caseEstimateVersions,
  type EstimateLineView,
  type EstimateVersionView,
  MAX_LINE_QUANTITY,
} from "@/estimate/version";
import type { CurrencyCode } from "@/money/currency";
import { type CaseMoney, caseMoney } from "@/money/view";
import { firstName } from "@/practice/chips";
import { PracticeError } from "@/practice/errors";
import { CATEGORY_ORDER, type ListGroup } from "@/practice/estimate";
import { approvedVersions } from "@/practice/panels";

import {
  aboveApproved,
  aboveHolds,
  approvedWithHeading,
  LINE_ABOVE_APPROVED,
  NOT_ON_ESTIMATE,
  NOTHING_HELD,
  QUANTITY_INVALID,
  SEEDED_HOLDS,
  WHOLE_NUMBER,
} from "./wording";

/** The prefix of a PayPal id written by a seed: PayPal never made it, so it is never sent to PayPal. */
export const SEEDED_ID_PREFIX = "SEEDED";

/** One line of the approved estimate, as the bill offers it. */
export interface BillItem {
  readonly estimateLineId: string;
  readonly code: string;
  /** The item's name on the practice's list. */
  readonly name: string;
  /** The line as the owner read it, when the vet or the agent worded it. */
  readonly ownerWording: string | null;
  readonly unit: string;
  readonly unitPricePence: number;
  /** The estimate's least: the quantity the bill starts from. */
  readonly quantityLow: number;
  /** The most the owner approved: the quantity a bill may charge up to. */
  readonly quantityHigh: number;
  readonly dependsOn: string | null;
}

/** The lines one approved version brought to the bill, under its heading. */
export interface BillGroup {
  readonly heading: string;
  readonly versionNumber: number;
  readonly lines: readonly BillItem[];
}

/** A line of a signed-off bill. */
export interface SignedLine {
  readonly estimateLineId: string;
  readonly code: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPricePence: number;
  readonly amountPence: number;
}

/** The bill as the vet signed it off. */
export interface SignedBill {
  readonly id: string;
  readonly signedOffAt: Date;
  readonly totalPence: number;
  readonly lines: readonly SignedLine[];
}

/** Everything the discharge page shows before anything is typed. */
export interface DischargeView {
  readonly case: {
    readonly id: string;
    readonly patientName: string;
    readonly ownerName: string;
    readonly ownerFirstName: string;
    readonly vetName: string | null;
  };
  readonly currency: CurrencyCode;
  readonly money: CaseMoney;
  /** The approved estimate's lines, under the version that approved each, in order. */
  readonly groups: readonly BillGroup[];
  /** What the case's open holds hold: the most a bill can charge. */
  readonly heldPence: number;
  /** Whether an open hold was seeded for the demo, so PayPal would refuse to capture it. */
  readonly seeded: boolean;
  /** The price list's items not on the bill, for work done that no estimate covers. */
  readonly unlisted: readonly ListGroup[];
  /** The bill as signed off, once it is. */
  readonly signed: SignedBill | null;
}

/**
 * Everything the discharge page shows, scoped to the practice: the bill's
 * lines from the estimate the owner approved last (each version carries the
 * whole estimate, so its lines are the bill's), grouped under the approved
 * version that first brought each line as it stands; what is held; and the
 * signed-off bill once there is one.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The view.
 * @throws PracticeError `case_not_found` when the practice has no such case.
 */
export async function loadDischargeView(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<DischargeView> {
  const [kase] = await executor
    .select()
    .from(patientCase)
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));
  if (!kase) {
    throw new PracticeError("case_not_found", `the practice has no case ${caseId}`);
  }
  const [money, versions, list, signed] = await Promise.all([
    caseMoney(executor, practiceId, caseId),
    caseEstimateVersions(executor, practiceId, caseId),
    currentPriceList(executor, practiceId),
    signedBill(executor, practiceId, caseId),
  ]);
  const approved = approvedVersions(
    versions.filter((version) => version.sentAt !== null),
    money.holds,
  );
  const open = money.holds.filter((one) => one.status === "authorised");
  const groups = billGroups(approved);
  const onBill = new Set(approved.at(-1)?.lines.map((line) => line.code) ?? []);
  return {
    case: {
      id: kase.id,
      patientName: kase.patientName,
      ownerName: kase.ownerName,
      ownerFirstName: firstName(kase.ownerName),
      vetName: kase.vetName,
    },
    currency: money.currency,
    money,
    groups,
    heldPence: money.heldPence,
    seeded: open.some((one) => one.paypalOrderId.startsWith(SEEDED_ID_PREFIX)),
    unlisted: list
      ? CATEGORY_ORDER.map((category) => ({
          category,
          items: [...list.items.values()]
            .filter((item) => item.category === category && !onBill.has(item.code))
            .map(({ code, name, unit, unitPricePence }) => ({ code, name, unit, unitPricePence })),
        })).filter((group) => group.items.length > 0)
      : [],
    signed,
  };
}

/**
 * The approved estimate's lines grouped by the version that approved each
 * as it stands: a line is the first version's if every version since carries
 * it unchanged, else the earliest version from which it is unchanged (an
 * update's new line, or a line an update raised).
 *
 * @param approved - The approved versions, in order.
 * @returns The groups, in order; an approved version that brought no line of its own has none.
 */
function billGroups(approved: readonly EstimateVersionView[]): BillGroup[] {
  const latest = approved.at(-1);
  if (!latest) {
    return [];
  }
  const keys = approved.map((version) => new Set(version.lines.map(lineKey)));
  const byVersion = approved.map(() => [] as BillItem[]);
  for (const line of latest.lines) {
    let from = approved.length - 1;
    while (from > 0 && keys[from - 1]!.has(lineKey(line))) {
      from -= 1;
    }
    byVersion[from]!.push(billItem(line));
  }
  return byVersion
    .map((lines, at) => ({
      heading: approvedWithHeading(at, approved.length),
      versionNumber: approved[at]!.number,
      lines,
    }))
    .filter((group) => group.lines.length > 0);
}

/**
 * What makes a line the same line from one version to the next.
 *
 * @param line - The line.
 * @returns Its key.
 */
function lineKey(line: EstimateLineView): string {
  return JSON.stringify([
    line.code,
    line.quantityLow,
    line.quantityHigh,
    line.dependsOn,
    line.ownerWording,
  ]);
}

/**
 * An estimate line as the bill offers it.
 *
 * @param line - The line.
 * @returns The bill's item.
 */
function billItem(line: EstimateLineView): BillItem {
  return {
    estimateLineId: line.id,
    code: line.code,
    name: line.name,
    ownerWording: line.ownerWording,
    unit: line.unit,
    unitPricePence: line.unitPricePence,
    quantityLow: line.quantityLow,
    quantityHigh: line.quantityHigh,
    dependsOn: line.dependsOn,
  };
}

/**
 * The case's signed-off bill, with its lines, or null when none is.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The bill.
 */
async function signedBill(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<SignedBill | null> {
  const [signed] = await executor
    .select()
    .from(bill)
    .where(and(eq(bill.caseId, caseId), eq(bill.practiceId, practiceId)));
  if (!signed) {
    return null;
  }
  const lines = await executor
    .select({
      estimateLineId: billLine.estimateLineId,
      code: priceListItem.code,
      name: priceListItem.name,
      quantity: billLine.quantity,
      unitPricePence: billLine.unitPricePence,
      amountPence: billLine.amountPence,
    })
    .from(billLine)
    .innerJoin(estimateLine, eq(estimateLine.id, billLine.estimateLineId))
    .innerJoin(priceListItem, eq(priceListItem.id, estimateLine.priceListItemId))
    .where(eq(billLine.billId, signed.id))
    .orderBy(asc(billLine.position));
  return {
    id: signed.id,
    signedOffAt: signed.signedOffAt,
    totalPence: signed.totalPence,
    lines,
  };
}

/** A quantity as typed: whole digits only, so "1e1" or "+3" is not read as some number. */
const typedQuantity = z
  .string()
  .trim()
  .regex(/^\d{1,4}$/)
  .transform(Number)
  .pipe(z.int().min(0).max(MAX_LINE_QUANTITY));

const reviewRequest = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  /** What was done, as typed, by estimate line id: every line the page showed. */
  quantities: z.record(z.uuid(), z.string().max(20)),
  /** Work done that no approved estimate covers: noted on the bill, never charged. */
  extras: z.array(z.strictObject({ code: priceListCode, quantity: z.string().max(20) })).max(50),
});

export type BillReviewRequest = z.input<typeof reviewRequest>;

/** One line of the bill as reviewed. */
export interface ReviewedLine {
  readonly estimateLineId: string;
  /** The quantity done, or null when what was typed is not a whole number. */
  readonly quantity: number | null;
  readonly amountPence: number;
  /** Why the line cannot be charged as it stands; null when it can. */
  readonly issue: string | null;
}

/** Work done that no approved estimate covers, as reviewed: noted, never charged. */
export interface ReviewedExtra {
  readonly code: string;
  readonly name: string;
  readonly quantity: number | null;
  /** What it would cost at the list's price; it is not charged. */
  readonly amountPence: number;
  readonly issue: string;
}

/** Whether the bill can be confirmed, and if not, why. */
export type BillVerdict =
  { readonly kind: "ready" } | { readonly kind: "refused"; readonly reason: string };

/** The bill as the vet has it: each line's money and fault, the totals and the verdict. */
export interface BillReview {
  readonly currency: CurrencyCode;
  readonly lines: readonly ReviewedLine[];
  readonly extras: readonly ReviewedExtra[];
  /** What the charged lines come to. */
  readonly billedPence: number;
  readonly heldPence: number;
  readonly verdict: BillVerdict;
}

/**
 * Reviews the bill as typed against the approved estimate, without writing
 * anything: each line priced from the estimate line it fulfils, a quantity
 * above what the owner approved refused with U3's sentence, work no approved
 * estimate covers refused with section 6's "Not on an approved estimate.
 * Send an update to charge it." and never charged, and the verdict on
 * whether it can be confirmed.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the case, the quantities typed and the work not on the estimate.
 * @returns The review.
 * @throws PracticeError `request_invalid` for a malformed request or an item not on the list or on the bill already; `stale` when the lines are not the ones the bill offers, or the bill is signed off.
 */
export async function reviewBill(
  executor: Executor,
  request: BillReviewRequest,
): Promise<BillReview> {
  const parsed = reviewRequest.safeParse(request);
  if (!parsed.success) {
    throw new PracticeError("request_invalid", "That bill could not be read.");
  }
  const { practiceId, caseId, quantities, extras } = parsed.data;
  const view = await loadDischargeView(executor, practiceId, caseId);
  if (view.signed) {
    throw new PracticeError(
      "stale",
      "The bill was signed off already. The page shows it as it is now.",
    );
  }
  const items = view.groups.flatMap((group) => group.lines);
  const offered = new Set(items.map((item) => item.estimateLineId));
  const typed = Object.keys(quantities);
  if (typed.length !== offered.size || typed.some((id) => !offered.has(id))) {
    throw new PracticeError(
      "stale",
      "The approved estimate changed since the page was opened. It shows as it is now.",
    );
  }

  const lines = items.map((item): ReviewedLine => {
    const quantity = typedQuantity.safeParse(quantities[item.estimateLineId]);
    if (!quantity.success) {
      return {
        estimateLineId: item.estimateLineId,
        quantity: null,
        amountPence: 0,
        issue: WHOLE_NUMBER,
      };
    }
    return {
      estimateLineId: item.estimateLineId,
      quantity: quantity.data,
      amountPence: quantity.data * item.unitPricePence,
      issue:
        quantity.data > item.quantityHigh ? aboveApproved(quantity.data, item.quantityHigh) : null,
    };
  });

  const list = new Map(
    view.unlisted.flatMap((group) => group.items).map((item) => [item.code, item]),
  );
  const onBill = new Map(items.map((item) => [item.code, item]));
  const seen = new Set<string>();
  const reviewedExtras = extras.map((extra): ReviewedExtra => {
    const already = onBill.get(extra.code);
    if (already) {
      throw new PracticeError(
        "request_invalid",
        `${already.name} is on the bill already: change its quantity there.`,
      );
    }
    const item = list.get(extra.code);
    if (!item) {
      throw new PracticeError("request_invalid", `${extra.code} is not on your price list.`);
    }
    if (seen.has(extra.code)) {
      throw new PracticeError("request_invalid", `${item.name} is noted once already.`);
    }
    seen.add(extra.code);
    const quantity = typedQuantity.safeParse(extra.quantity);
    return {
      code: item.code,
      name: item.name,
      quantity: quantity.success ? quantity.data : null,
      amountPence: quantity.success ? quantity.data * item.unitPricePence : 0,
      issue: quantity.success ? NOT_ON_ESTIMATE : WHOLE_NUMBER,
    };
  });

  const billedPence = lines.reduce((sum, line) => sum + line.amountPence, 0);
  return {
    currency: view.currency,
    lines,
    extras: reviewedExtras,
    billedPence,
    heldPence: view.heldPence,
    verdict: verdictOf(view, lines, reviewedExtras, billedPence),
  };
}

/**
 * Whether the bill can be confirmed, the first reason it cannot in the order
 * the vet would fix them: nothing held; holds seeded for the demo; a quantity
 * not a whole number; a bill above the holds (rule 1); a line above what the
 * owner approved.
 *
 * @param view - The discharge page's view.
 * @param lines - The reviewed lines.
 * @param extras - The reviewed work not on the estimate.
 * @param billedPence - What the charged lines come to.
 * @returns The verdict.
 */
function verdictOf(
  view: DischargeView,
  lines: readonly ReviewedLine[],
  extras: readonly ReviewedExtra[],
  billedPence: number,
): BillVerdict {
  if (view.heldPence === 0) {
    return { kind: "refused", reason: NOTHING_HELD };
  }
  if (view.seeded) {
    return { kind: "refused", reason: SEEDED_HOLDS };
  }
  if (lines.some((line) => line.quantity === null) || extras.some((one) => one.quantity === null)) {
    return { kind: "refused", reason: QUANTITY_INVALID };
  }
  if (billedPence > view.heldPence) {
    return { kind: "refused", reason: aboveHolds(billedPence, view.heldPence, view.currency) };
  }
  if (lines.some((line) => line.issue !== null)) {
    return { kind: "refused", reason: LINE_ABOVE_APPROVED };
  }
  return { kind: "ready" };
}
