import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Executor, Transaction } from "@/db/client";
import {
  auditActor,
  estimateLine,
  estimateVersion,
  moneyState,
  patientCase,
  priceList,
  priceListItem,
} from "@/db/schema";
import { type CurrencyCode, currencyCode, MAX_PENCE } from "@/money/currency";

import { EstimateError, type EstimateLineIssue } from "./errors";
import {
  currentPriceList,
  type PriceCategory,
  priceListCode,
  type PriceListWithItems,
} from "./price-list";

export { EstimateError, type EstimateLineIssue, type EstimateRefusal } from "./errors";

/**
 * The most a line's quantity may be. With the largest unit price
 * (`MAX_UNIT_PRICE_PENCE`), a line's money stays inside a Postgres `integer`.
 */
export const MAX_LINE_QUANTITY = 1_000;

/** The most lines one version holds. */
export const MAX_VERSION_LINES = 200;

/**
 * One line of an estimate as a vet or the drafting agent gives it: a price
 * list code and a quantity range. **It has no price**: the server prices
 * every line from the practice's list (plan 3.3, 3.4).
 */
export const estimateLineInput = z
  .strictObject({
    code: priceListCode,
    quantityLow: z.int().min(0).max(MAX_LINE_QUANTITY),
    quantityHigh: z.int().min(1).max(MAX_LINE_QUANTITY),
    /** The finding the line depends on, as "only if extractions are needed". */
    dependsOn: z.string().trim().min(1).max(300).optional(),
    /** The exact words of the vet's notes the line came from. */
    notesSpan: z.string().min(1).max(2_000).optional(),
    /** The line in the owner's words; the item's own name when absent. */
    ownerWording: z.string().trim().min(1).max(500).optional(),
  })
  .refine((line) => line.quantityLow <= line.quantityHigh, {
    message: "the low quantity is above the high one",
    path: ["quantityLow"],
  });

export type EstimateLineInput = z.input<typeof estimateLineInput>;

/** A range of money in pence: the low and the high end. */
export interface PenceRange {
  readonly lowPence: number;
  readonly highPence: number;
}

/** A priced line of a stored version. */
export interface EstimateLineView extends PenceRange {
  readonly id: string;
  readonly position: number;
  readonly code: string;
  readonly name: string;
  readonly category: PriceCategory;
  readonly unit: string;
  readonly unitPricePence: number;
  readonly quantityLow: number;
  readonly quantityHigh: number;
  readonly dependsOn: string | null;
  readonly notesSpan: string | null;
  readonly ownerWording: string | null;
}

/** A stored estimate version, its lines in order and its total as a range. */
export interface EstimateVersionView {
  readonly id: string;
  readonly practiceId: string;
  readonly caseId: string;
  readonly number: number;
  readonly priceListId: string;
  readonly currency: CurrencyCode;
  readonly createdAt: Date;
  /** When it was sent to the owner; null while it is a draft. */
  readonly sentAt: Date | null;
  readonly lines: readonly EstimateLineView[];
  /** The total as a range; the hold is its top (D3). */
  readonly totals: PenceRange;
}

const actor = z.enum(auditActor.enumValues);

const makeRequest = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  actor,
  lines: z.array(z.unknown()).max(MAX_VERSION_LINES),
});

const versionRequest = z.strictObject({
  practiceId: z.uuid(),
  versionId: z.uuid(),
  actor,
});

const moneyStateName = z.enum(moneyState.enumValues);

const sendRequest = versionRequest.extend({
  moneyState: z.strictObject({ before: moneyStateName, after: moneyStateName }).optional(),
});

const replaceRequest = versionRequest.extend({
  lines: z.array(z.unknown()).max(MAX_VERSION_LINES),
});

/** What {@link makeEstimateVersion} takes. */
export interface MakeEstimateVersionRequest {
  readonly practiceId: string;
  readonly caseId: string;
  readonly actor: z.input<typeof actor>;
  readonly lines: readonly EstimateLineInput[];
}

/** A version by id, and who acts on it. */
export interface VersionRequest {
  readonly practiceId: string;
  readonly versionId: string;
  readonly actor: z.input<typeof actor>;
}

/** What {@link sendEstimateVersion} takes. */
export interface SendEstimateVersionRequest extends VersionRequest {
  /**
   * The case's money states before and after the send, when the money
   * lifecycle (U3) moves the case in the same transaction: carried on the one
   * `estimate.sent` event, so the transition writes one audit event.
   */
  readonly moneyState?: {
    readonly before: z.input<typeof moneyStateName>;
    readonly after: z.input<typeof moneyStateName>;
  };
}

/** What {@link replaceDraftLines} takes. */
export interface ReplaceDraftLinesRequest extends VersionRequest {
  readonly lines: readonly EstimateLineInput[];
}

/**
 * Makes the case's next estimate version, a draft, its lines priced from the
 * practice's current price list, and writes `estimate.version_made`. The
 * first version is the estimate; each later one is a change to a sent
 * version, which never changes itself. A case has one draft at a time.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the case, who made it and its lines (none for an empty draft).
 * @returns The draft.
 * @throws EstimateError when the case is not the practice's, the practice
 *   has no price list, a draft is open, or a line is refused.
 */
export async function makeEstimateVersion(
  executor: Executor,
  request: MakeEstimateVersionRequest,
): Promise<EstimateVersionView> {
  const { practiceId, caseId, actor: by, lines } = parseRequest(makeRequest, request);
  return executor.transaction(async (tx) => {
    const [kase] = await tx
      .select({ id: patientCase.id, currencyCode: patientCase.currencyCode })
      .from(patientCase)
      .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)))
      .for("update");
    if (!kase) {
      throw new EstimateError("case_not_found", `the practice has no case ${caseId}`);
    }
    const list = await currentPriceList(tx, practiceId);
    if (!list) {
      throw new EstimateError("no_price_list", "the practice has no price list to price from");
    }
    if (list.currencyCode !== kase.currencyCode) {
      throw new EstimateError(
        "currency_mismatch",
        `the case is in ${kase.currencyCode}, the price list in ${list.currencyCode}`,
      );
    }
    const priced = priceLines(list, lines);

    const [open] = await tx
      .select({ number: estimateVersion.number })
      .from(estimateVersion)
      .where(and(eq(estimateVersion.caseId, caseId), isNull(estimateVersion.sentAt)));
    if (open) {
      throw new EstimateError(
        "draft_exists",
        `version ${open.number} of this estimate is a draft; change it or send it first`,
      );
    }
    const [latest] = await tx
      .select({ number: max(estimateVersion.number) })
      .from(estimateVersion)
      .where(eq(estimateVersion.caseId, caseId));
    const number = (latest?.number ?? 0) + 1;

    const [version] = await tx
      .insert(estimateVersion)
      .values({ practiceId, caseId, priceListId: list.id, number })
      .returning({ id: estimateVersion.id });
    await insertLines(tx, version!.id, list.id, priced);
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: by,
      action: "estimate.version_made",
      detail: {
        versionId: version!.id,
        number,
        priceListId: list.id,
        lineCount: priced.length,
        ...totalsOf(priced),
      },
    });
    return mustLoad(tx, practiceId, version!.id);
  });
}

/**
 * Replaces a draft's lines, priced from the practice's current price list
 * (so a draft made before a new import is repriced), and writes
 * `estimate.draft_changed`. A sent version's lines never change: make a new
 * version instead.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the draft, who changed it and its new lines.
 * @returns The draft as changed.
 * @throws EstimateError when the version is not the practice's, is sent, or a line is refused.
 */
export async function replaceDraftLines(
  executor: Executor,
  request: ReplaceDraftLinesRequest,
): Promise<EstimateVersionView> {
  const { practiceId, versionId, actor: by, lines } = parseRequest(replaceRequest, request);
  return executor.transaction(async (tx) => {
    const version = await lockVersion(tx, practiceId, versionId);
    const list = await currentPriceList(tx, practiceId);
    const priced = priceLines(list!, lines);
    await tx.delete(estimateLine).where(eq(estimateLine.versionId, versionId));
    if (list!.id !== version.priceListId) {
      await tx
        .update(estimateVersion)
        .set({ priceListId: list!.id })
        .where(eq(estimateVersion.id, versionId));
    }
    await insertLines(tx, versionId, list!.id, priced);
    await appendAuditEvent(tx, {
      practiceId,
      caseId: version.caseId,
      actor: by,
      action: "estimate.draft_changed",
      detail: {
        versionId,
        number: version.number,
        priceListId: list!.id,
        lineCount: priced.length,
        ...totalsOf(priced),
      },
    });
    return mustLoad(tx, practiceId, versionId);
  });
}

/**
 * Sends a draft to the owner: from now on it never changes. A draft priced
 * from a list the practice has since replaced is refused until its lines are
 * replaced (and so repriced). Its totals are
 * set from its lines (the database checks them, migration 0003) and
 * `estimate.sent` is written with the top of the range as the amount, the sum
 * a hold is made for (D3). The case's money state is the money lifecycle's to
 * move (U3), in the same transaction.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the draft and who sent it.
 * @returns The version as sent.
 * @throws EstimateError when the version is not the practice's, is already sent, or has no lines.
 */
export async function sendEstimateVersion(
  executor: Executor,
  request: SendEstimateVersionRequest,
): Promise<EstimateVersionView> {
  const {
    practiceId,
    versionId,
    actor: by,
    moneyState: moved,
  } = parseRequest(sendRequest, request);
  return executor.transaction(async (tx) => {
    const locked = await lockVersion(tx, practiceId, versionId);
    const draft = await mustLoad(tx, practiceId, versionId);
    if (draft.lines.length === 0) {
      throw new EstimateError("empty", `version ${draft.number} has no lines to send`);
    }
    const current = await currentPriceList(tx, practiceId);
    if (current?.id !== draft.priceListId) {
      throw new EstimateError(
        "price_list_changed",
        `version ${draft.number} is priced from a list since replaced; replace its lines to reprice it`,
      );
    }
    const { lowPence, highPence } = draft.totals;
    await tx
      .update(estimateVersion)
      .set({ sentAt: sql`now()`, totalLowPence: lowPence, totalHighPence: highPence })
      .where(eq(estimateVersion.id, versionId));
    await appendAuditEvent(tx, {
      practiceId,
      caseId: locked.caseId,
      actor: by,
      action: "estimate.sent",
      ...(moved ? { moneyStateBefore: moved.before, moneyStateAfter: moved.after } : {}),
      amount: { pence: highPence, currency: draft.currency },
      detail: { versionId, number: draft.number, lowPence, highPence },
    });
    return mustLoad(tx, practiceId, versionId);
  });
}

/**
 * A practice's estimate version by id, with its priced lines.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice the version must belong to.
 * @param versionId - The version.
 * @returns The version, or null when the practice has no such version.
 */
export async function loadEstimateVersion(
  executor: Executor,
  practiceId: string,
  versionId: string,
): Promise<EstimateVersionView | null> {
  const [version] = await executor
    .select({
      id: estimateVersion.id,
      practiceId: estimateVersion.practiceId,
      caseId: estimateVersion.caseId,
      number: estimateVersion.number,
      priceListId: estimateVersion.priceListId,
      currencyCode: priceList.currencyCode,
      createdAt: estimateVersion.createdAt,
      sentAt: estimateVersion.sentAt,
      totalLowPence: estimateVersion.totalLowPence,
      totalHighPence: estimateVersion.totalHighPence,
    })
    .from(estimateVersion)
    .innerJoin(priceList, eq(priceList.id, estimateVersion.priceListId))
    .where(and(eq(estimateVersion.id, versionId), eq(estimateVersion.practiceId, practiceId)));
  if (!version) {
    return null;
  }
  const lines = await executor
    .select({
      id: estimateLine.id,
      position: estimateLine.position,
      code: priceListItem.code,
      name: priceListItem.name,
      category: priceListItem.category,
      unit: priceListItem.unit,
      unitPricePence: estimateLine.unitPricePence,
      quantityLow: estimateLine.quantityLow,
      quantityHigh: estimateLine.quantityHigh,
      lowPence: estimateLine.lowPence,
      highPence: estimateLine.highPence,
      dependsOn: estimateLine.dependsOn,
      notesSpan: estimateLine.notesSpan,
      ownerWording: estimateLine.ownerWording,
    })
    .from(estimateLine)
    .innerJoin(priceListItem, eq(priceListItem.id, estimateLine.priceListItemId))
    .where(eq(estimateLine.versionId, versionId))
    .orderBy(asc(estimateLine.position));

  const { totalLowPence, totalHighPence, currencyCode: currency, ...rest } = version;
  return {
    ...rest,
    currency: currencyCode.parse(currency),
    lines,
    totals:
      totalLowPence !== null && totalHighPence !== null
        ? { lowPence: totalLowPence, highPence: totalHighPence }
        : totalsOf(lines),
  };
}

/**
 * The case's versions, in number order.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The versions, first to last.
 */
export async function caseEstimateVersions(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<EstimateVersionView[]> {
  const ids = await executor
    .select({ id: estimateVersion.id })
    .from(estimateVersion)
    .where(and(eq(estimateVersion.caseId, caseId), eq(estimateVersion.practiceId, practiceId)))
    .orderBy(asc(estimateVersion.number));
  return Promise.all(ids.map(({ id }) => mustLoad(executor, practiceId, id)));
}

/**
 * A version's lines as input for the next version, so a change starts from
 * what was sent.
 *
 * @param version - The version.
 * @returns Its lines, unpriced.
 */
export function linesOf(version: EstimateVersionView): EstimateLineInput[] {
  return version.lines.map((line) => ({
    code: line.code,
    quantityLow: line.quantityLow,
    quantityHigh: line.quantityHigh,
    ...(line.dependsOn === null ? {} : { dependsOn: line.dependsOn }),
    ...(line.notesSpan === null ? {} : { notesSpan: line.notesSpan }),
    ...(line.ownerWording === null ? {} : { ownerWording: line.ownerWording }),
  }));
}

/** One item's quantities and money in a version. */
export interface ItemAmount extends PenceRange {
  readonly quantityLow: number;
  readonly quantityHigh: number;
}

/** How one price list item differs between two versions. */
export interface ItemDelta extends PenceRange {
  readonly code: string;
  readonly name: string;
  readonly change: "added" | "removed" | "changed";
  readonly before: ItemAmount | null;
  readonly after: ItemAmount | null;
}

/** What changed from one version of a case's estimate to another. */
export interface EstimateDelta {
  readonly from: { readonly versionId: string; readonly number: number };
  readonly to: { readonly versionId: string; readonly number: number };
  /** Each item that differs, in the later version's order, then those it dropped. */
  readonly items: readonly ItemDelta[];
  /** The change in each end of the total, signed. */
  readonly totals: PenceRange;
}

/**
 * The delta between two versions of a case's estimate, by price list item: an
 * item's lines are summed, so it is compared as a whole. The money is each
 * version's own, so a price changed between the lists they were priced from
 * shows as a change too. Amounts are signed: a removal is negative.
 *
 * @param from - The earlier version.
 * @param to - The later version.
 * @returns The delta.
 * @throws EstimateError when the versions are of different cases.
 */
export function estimateDelta(from: EstimateVersionView, to: EstimateVersionView): EstimateDelta {
  if (from.caseId !== to.caseId) {
    throw new EstimateError("different_cases", "versions of different cases are not compared");
  }
  const before = amountsByItem(from);
  const after = amountsByItem(to);
  const items: ItemDelta[] = [];
  for (const [code, now] of after) {
    const was = before.get(code);
    if (!was) {
      items.push({
        ...now.name,
        change: "added",
        before: null,
        after: now.amount,
        lowPence: now.amount.lowPence,
        highPence: now.amount.highPence,
      });
    } else if (!sameAmount(was.amount, now.amount)) {
      items.push({
        ...now.name,
        change: "changed",
        before: was.amount,
        after: now.amount,
        lowPence: now.amount.lowPence - was.amount.lowPence,
        highPence: now.amount.highPence - was.amount.highPence,
      });
    }
  }
  for (const [code, was] of before) {
    if (!after.has(code)) {
      items.push({
        ...was.name,
        change: "removed",
        before: was.amount,
        after: null,
        lowPence: -was.amount.lowPence,
        highPence: -was.amount.highPence,
      });
    }
  }
  return {
    from: { versionId: from.id, number: from.number },
    to: { versionId: to.id, number: to.number },
    items,
    totals: {
      lowPence: to.totals.lowPence - from.totals.lowPence,
      highPence: to.totals.highPence - from.totals.highPence,
    },
  };
}

/**
 * A version's quantities and money summed by item code, in the version's order.
 *
 * @param version - The version.
 * @returns Each item's name and amount, by code.
 */
function amountsByItem(
  version: EstimateVersionView,
): Map<string, { name: { code: string; name: string }; amount: ItemAmount }> {
  const byCode = new Map<string, { name: { code: string; name: string }; amount: ItemAmount }>();
  for (const line of version.lines) {
    const seen = byCode.get(line.code)?.amount;
    byCode.set(line.code, {
      name: { code: line.code, name: line.name },
      amount: {
        quantityLow: (seen?.quantityLow ?? 0) + line.quantityLow,
        quantityHigh: (seen?.quantityHigh ?? 0) + line.quantityHigh,
        lowPence: (seen?.lowPence ?? 0) + line.lowPence,
        highPence: (seen?.highPence ?? 0) + line.highPence,
      },
    });
  }
  return byCode;
}

/**
 * Whether two item amounts are the same.
 *
 * @param a - One.
 * @param b - The other.
 * @returns True when every quantity and sum matches.
 */
function sameAmount(a: ItemAmount, b: ItemAmount): boolean {
  return (
    a.quantityLow === b.quantityLow &&
    a.quantityHigh === b.quantityHigh &&
    a.lowPence === b.lowPence &&
    a.highPence === b.highPence
  );
}

/** A line checked and priced from a list, ready to store. */
interface PricedLine extends PenceRange {
  readonly itemId: string;
  readonly unitPricePence: number;
  readonly input: z.output<typeof estimateLineInput>;
}

/**
 * Checks each line and prices it from the list. Every fault on every line is
 * reported together.
 *
 * @param list - The price list.
 * @param lines - The lines as given.
 * @returns The priced lines.
 * @throws EstimateError when any line is refused, or the total passes the largest amount stored.
 */
function priceLines(list: PriceListWithItems, lines: readonly unknown[]): PricedLine[] {
  const issues: EstimateLineIssue[] = [];
  const priced: PricedLine[] = [];
  lines.forEach((raw, at) => {
    const given = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const code = typeof given.code === "string" ? given.code : null;
    const parsed = estimateLineInput.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ line: at + 1, code, message: lineIssueMessage(issue) });
      }
      return;
    }
    const item = list.items.get(parsed.data.code);
    if (!item) {
      issues.push({
        line: at + 1,
        code,
        message: `${parsed.data.code} is not on the practice's price list`,
      });
      return;
    }
    priced.push({
      itemId: item.id,
      unitPricePence: item.unitPricePence,
      lowPence: item.unitPricePence * parsed.data.quantityLow,
      highPence: item.unitPricePence * parsed.data.quantityHigh,
      input: parsed.data,
    });
  });
  if (issues.length > 0) {
    throw new EstimateError(
      "lines_refused",
      `estimate lines refused: ${issues.map((issue) => `line ${issue.line}: ${issue.message}`).join("; ")}`,
      issues,
    );
  }
  if (totalsOf(priced).highPence > MAX_PENCE) {
    throw new EstimateError("too_large", "the estimate's total is past the largest amount stored");
  }
  return priced;
}

/**
 * A line's validation fault in words. A price, of any name, is refused as the
 * rule it breaks: the server prices every line.
 *
 * @param issue - The fault.
 * @returns The sentence.
 */
function lineIssueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    const priceLike = issue.keys.filter((key) => /price|pence|amount|total|cost/i.test(key));
    if (priceLike.length > 0) {
      return `a line carries no price of its own: ${priceLike.join(", ")}`;
    }
    return `a line has no field ${issue.keys.join(", ")}`;
  }
  const field = issue.path.join(".");
  return field === "" || issue.code === "custom" ? issue.message : `${field}: ${issue.message}`;
}

/**
 * The total of some lines as a range.
 *
 * @param lines - The lines' money.
 * @returns The sums of the low and the high ends.
 */
function totalsOf(lines: readonly PenceRange[]): PenceRange {
  return lines.reduce(
    (sum, line) => ({
      lowPence: sum.lowPence + line.lowPence,
      highPence: sum.highPence + line.highPence,
    }),
    { lowPence: 0, highPence: 0 },
  );
}

/**
 * Stores priced lines on a version, numbered from 1 in the order given.
 *
 * @param tx - The open transaction.
 * @param versionId - The version.
 * @param priceListId - The list they were priced from.
 * @param lines - The priced lines.
 * @returns Resolves once stored.
 */
async function insertLines(
  tx: Transaction,
  versionId: string,
  priceListId: string,
  lines: readonly PricedLine[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }
  await tx.insert(estimateLine).values(
    lines.map((line, at) => ({
      versionId,
      priceListId,
      position: at + 1,
      priceListItemId: line.itemId,
      unitPricePence: line.unitPricePence,
      quantityLow: line.input.quantityLow,
      quantityHigh: line.input.quantityHigh,
      dependsOn: line.input.dependsOn ?? null,
      notesSpan: line.input.notesSpan ?? null,
      ownerWording: line.input.ownerWording ?? null,
    })),
  );
}

/**
 * Locks a practice's draft version for a change.
 *
 * @param tx - The open transaction.
 * @param practiceId - The practice.
 * @param versionId - The version.
 * @returns The version's case, number and price list.
 * @throws EstimateError when there is no such version or it is sent.
 */
async function lockVersion(
  tx: Transaction,
  practiceId: string,
  versionId: string,
): Promise<{ caseId: string; number: number; priceListId: string }> {
  const [version] = await tx
    .select({
      caseId: estimateVersion.caseId,
      number: estimateVersion.number,
      priceListId: estimateVersion.priceListId,
      sentAt: estimateVersion.sentAt,
    })
    .from(estimateVersion)
    .where(and(eq(estimateVersion.id, versionId), eq(estimateVersion.practiceId, practiceId)))
    .for("update");
  if (!version) {
    throw new EstimateError(
      "version_not_found",
      `the practice has no estimate version ${versionId}`,
    );
  }
  if (version.sentAt !== null) {
    throw new EstimateError(
      "sent",
      `version ${version.number} was sent and never changes; make a new version`,
    );
  }
  return version;
}

/**
 * Loads a version known to exist.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param versionId - The version.
 * @returns The version.
 * @throws EstimateError when it is not there.
 */
async function mustLoad(
  executor: Executor,
  practiceId: string,
  versionId: string,
): Promise<EstimateVersionView> {
  const version = await loadEstimateVersion(executor, practiceId, versionId);
  if (!version) {
    throw new EstimateError(
      "version_not_found",
      `the practice has no estimate version ${versionId}`,
    );
  }
  return version;
}

/**
 * Parses a request, turning a malformed one into a refusal.
 *
 * @param schema - The request's schema.
 * @param request - The request.
 * @returns The parsed request.
 * @throws EstimateError when the request does not parse.
 */
function parseRequest<T extends z.ZodType>(schema: T, request: unknown): z.output<T> {
  const parsed = schema.safeParse(request);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    const tooMany = first?.code === "too_big" && first.path[0] === "lines";
    throw new EstimateError(
      tooMany ? "too_large" : "request_invalid",
      `estimate request refused: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
