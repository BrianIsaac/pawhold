import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { draftEstimate, type DraftedEstimate } from "@/agent/draft";
import { checkOwnerWording } from "@/agent/guardrails";
import type { AgentDependencies } from "@/agent/jobs";
import { appendAuditEvent } from "@/audit/writer";
import type { Database, Executor, Transaction } from "@/db/client";
import { bill, estimateSource, patientCase } from "@/db/schema";
import { currentPriceList, type PriceCategory, priceListCode } from "@/estimate/price-list";
import {
  caseEstimateVersions,
  type EstimateLineInput,
  type EstimateVersionView,
  linesOf,
  loadEstimateVersion,
  makeEstimateVersion,
  MAX_LINE_QUANTITY,
  replaceDraftLines,
} from "@/estimate/version";
import type { CurrencyCode } from "@/money/currency";
import { sendEstimate, type SentEstimate, withdrawEstimate } from "@/money/holds";
import type { MoneyState } from "@/money/state";
import { type CaseMoney, caseMoney } from "@/money/view";

import { firstName, type MoneyChip, moneyChips } from "./chips";
import { PracticeError } from "./errors";
import { approvedVersions, type VersionPanel, versionPanel } from "./panels";

export type { VersionPanel } from "./panels";
import { caseSources, keepSourceOrRefuse } from "./sources";
import { loadUpdateView, type UpdateView } from "./update";
import { parsePracticeRequest } from "./cases";

/** A price list item the vet can add by hand. */
export interface ListItem {
  readonly code: string;
  readonly name: string;
  readonly unit: string;
  readonly unitPricePence: number;
}

/** The practice's price list, by category, for adding an item by hand. */
export interface ListGroup {
  readonly category: PriceCategory;
  readonly items: readonly ListItem[];
}

/** The states in which the first estimate is being made or is with the owner. */
const ESTIMATE_PHASE: readonly MoneyState[] = ["estimate_draft", "awaiting_owner", "withdrawn"];

/** The states in which work is held and an update may be drafted and sent. */
const UPDATE_OPEN: readonly MoneyState[] = ["held", "update_declined"];

/** Everything the case page shows. */
export interface CaseView {
  readonly case: {
    readonly id: string;
    readonly patientName: string;
    readonly ownerName: string;
    readonly ownerFirstName: string;
    readonly procedure: string;
    readonly vetName: string | null;
  };
  readonly money: CaseMoney;
  readonly chips: readonly MoneyChip[];
  readonly currency: CurrencyCode;
  /** The first estimate: its open draft, or what was sent (or, once held, what the owner approved). */
  readonly estimate: {
    readonly draft: VersionPanel | null;
    readonly sent: VersionPanel | null;
  };
  /** The versions the owner approved, in order: each one a hold was authorised for. */
  readonly approved: readonly VersionPanel[];
  /** Whether an update may be drafted and sent now: the case held and its bill not signed off. */
  readonly canUpdate: boolean;
  /** The update half: the update drafted, with the owner, declined, approved. */
  readonly update: UpdateView;
  readonly priceList: readonly ListGroup[];
}

/** The order the price list's categories are offered in (plan 3.3). */
const CATEGORY_ORDER: readonly PriceCategory[] = [
  "consultation",
  "anaesthesia",
  "procedure",
  "imaging",
  "laboratory",
  "medication",
  "hospitalisation",
  "consumable",
];

/**
 * Everything the case page shows, scoped to the practice.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The case's view.
 * @throws PracticeError `case_not_found` when the practice has no such case.
 */
export async function loadCaseView(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<CaseView> {
  const [kase] = await executor
    .select()
    .from(patientCase)
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));
  if (!kase) {
    throw new PracticeError("case_not_found", `the practice has no case ${caseId}`);
  }
  const [money, versions, sources, list, signed] = await Promise.all([
    caseMoney(executor, practiceId, caseId),
    caseEstimateVersions(executor, practiceId, caseId),
    caseSources(executor, caseId),
    currentPriceList(executor, practiceId),
    executor.select({ id: bill.id }).from(bill).where(eq(bill.caseId, caseId)),
  ]);
  const panel = (version: EstimateVersionView, from = 0): VersionPanel =>
    versionPanel(version, sources.get(version.id) ?? null, from);
  const open = versions.find((version) => version.sentAt === null) ?? null;
  const sent = versions.filter((version) => version.sentAt !== null);
  const approved = approvedVersions(sent, money.holds);
  const inEstimatePhase = ESTIMATE_PHASE.includes(money.state);
  const canUpdate = UPDATE_OPEN.includes(money.state) && signed.length === 0;
  const update = await loadUpdateView(executor, {
    practiceId,
    caseId,
    ownerFirstName: firstName(kase.ownerName),
    money,
    versions,
    sources,
    approved,
    canUpdate,
  });

  return {
    case: {
      id: kase.id,
      patientName: kase.patientName,
      ownerName: kase.ownerName,
      ownerFirstName: firstName(kase.ownerName),
      procedure: kase.procedure,
      vetName: kase.vetName,
    },
    money,
    chips: moneyChips(money),
    currency: money.currency,
    estimate: {
      draft: inEstimatePhase && open ? panel(open) : null,
      sent: inEstimatePhase
        ? sent.length > 0
          ? panel(sent.at(-1)!)
          : null
        : approved[0]
          ? panel(approved[0])
          : null,
    },
    approved: approved.map((version, at) =>
      panel(version, at === 0 ? 0 : approved[at - 1]!.lines.length),
    ),
    canUpdate,
    update,
    priceList: list
      ? CATEGORY_ORDER.map((category) => ({
          category,
          items: [...list.items.values()]
            .filter((item) => item.category === category)
            .map(({ code, name, unit, unitPricePence }) => ({ code, name, unit, unitPricePence })),
        })).filter((group) => group.items.length > 0)
      : [],
  };
}

const draftForCaseRequest = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  notes: z.string(),
});

/**
 * "Draft estimate" (section 6): U4's draft from the vet's notes, then the
 * notes and what the draft made of them kept beside the draft, so the page
 * shows each line's span in them on every visit.
 *
 * @param agent - The estimate agent.
 * @param request - The practice, the case and the notes.
 * @returns The draft as U4 answers it.
 * @throws EstimateError as `draftEstimate` refuses.
 */
export async function draftForCase(
  agent: AgentDependencies,
  request: z.input<typeof draftForCaseRequest>,
): Promise<DraftedEstimate> {
  const { practiceId, caseId, notes } = draftForCaseRequest.parse(request);
  const drafted = await draftEstimate(agent, { practiceId, caseId, notes });
  await keepSourceOrRefuse(agent.db, {
    versionId: drafted.version.id,
    practiceId,
    caseId,
    kind: "notes",
    text: notes,
    outcome: drafted,
    preservedLines: drafted.failure !== null && drafted.version.lines.length > 0,
  });
  return drafted;
}

/**
 * A quantity as typed: whole digits only, so a blank, "1e1" or "+3" is
 * refused rather than read as some number.
 *
 * @param min - The least it may be.
 * @returns The schema.
 */
function quantity(min: number) {
  return z.preprocess(
    (value) => (typeof value === "number" ? String(value) : value),
    z
      .string()
      .trim()
      .regex(/^\d+$/, "Enter a whole number")
      .transform(Number)
      .pipe(
        z.int().min(min, `At least ${min}`).max(MAX_LINE_QUANTITY, `At most ${MAX_LINE_QUANTITY}`),
      ),
  );
}

const WORDING_REFUSED =
  "The owner's wording can't carry an amount, a percentage or a dose: prices come from your list.";

/**
 * Words the owner reads, checked as the agent's are (plan 3.4): no amount,
 * percentage or dose. Empty means none.
 *
 * @param max - The longest it may be.
 * @returns The schema.
 */
function ownerWords(max: number) {
  return z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .refine((text) => text === "" || checkOwnerWording(text) === null, WORDING_REFUSED)
    .transform((text) => (text === "" ? undefined : text));
}

const lineFields = z
  .object({
    quantityLow: quantity(0),
    quantityHigh: quantity(1),
    dependsOn: ownerWords(300).optional(),
    ownerWording: ownerWords(500).optional(),
  })
  .refine((line) => line.quantityLow <= line.quantityHigh, {
    message: "The least can't be more than the most",
    path: ["quantityLow"],
  });

const editRequest = z
  .object({ practiceId: z.uuid(), versionId: z.uuid(), lineId: z.uuid() })
  .and(lineFields);

const removeRequest = z.strictObject({
  practiceId: z.uuid(),
  versionId: z.uuid(),
  lineId: z.uuid(),
});

const addRequest = z
  .object({
    practiceId: z.uuid(),
    caseId: z.uuid(),
    code: priceListCode.or(z.literal("")).refine((code) => code !== "", "Choose an item"),
  })
  .and(lineFields);

/**
 * A line as input with its quantities, condition and wording replaced.
 *
 * @param line - The line as it stands.
 * @param fields - The new quantities, condition and wording.
 * @returns The line as input.
 */
function withFields(
  line: EstimateLineInput,
  fields: z.output<typeof lineFields>,
): EstimateLineInput {
  return {
    code: line.code,
    ...(line.notesSpan === undefined ? {} : { notesSpan: line.notesSpan }),
    quantityLow: fields.quantityLow,
    quantityHigh: fields.quantityHigh,
    ...(fields.dependsOn === undefined ? {} : { dependsOn: fields.dependsOn }),
    ...(fields.ownerWording === undefined ? {} : { ownerWording: fields.ownerWording }),
  };
}

/**
 * Locks a practice's draft for a change by the vet.
 *
 * @param tx - The transaction.
 * @param practiceId - The practice.
 * @param versionId - The draft.
 * @returns The draft.
 * @throws PracticeError when there is no such version, or it was sent since the page was read.
 */
async function lockDraft(
  tx: Transaction,
  practiceId: string,
  versionId: string,
): Promise<EstimateVersionView> {
  const version = await loadEstimateVersion(tx, practiceId, versionId);
  if (!version) {
    throw new PracticeError("version_not_found", "That estimate is not this practice's.");
  }
  await tx
    .select({ id: patientCase.id })
    .from(patientCase)
    .where(eq(patientCase.id, version.caseId))
    .for("update");
  const locked = (await loadEstimateVersion(tx, practiceId, versionId))!;
  if (locked.sentAt !== null) {
    throw new PracticeError("stale", "This estimate was sent since the page was opened.");
  }
  return locked;
}

/**
 * Refuses a change to a line an update draft carries from the version the
 * owner approved: an update only adds to what is held (plan 3.2, "scope
 * frozen at what is held"), as the update's screen shows it.
 *
 * @param tx - The transaction holding the case's lock.
 * @param practiceId - The practice.
 * @param draft - The draft.
 * @param at - The line's index in the draft.
 * @throws PracticeError `stale` when the line is one the owner approved.
 */
async function refuseApprovedLine(
  tx: Transaction,
  practiceId: string,
  draft: EstimateVersionView,
  at: number,
): Promise<void> {
  const versions = await caseEstimateVersions(tx, practiceId, draft.caseId);
  const money = await caseMoney(tx, practiceId, draft.caseId);
  const base = approvedVersions(
    versions.filter((version) => version.sentAt !== null && version.number < draft.number),
    money.holds,
  ).at(-1);
  if (base && at < base.lines.length) {
    throw new PracticeError(
      "stale",
      "That line is in the estimate the owner approved. An update only adds to it.",
    );
  }
}

/**
 * Changes one line of a draft: its quantities, its condition ("Only if") and
 * the owner's wording, U2 repricing the draft from the list, written by the
 * vet. The line keeps its place and its span.
 *
 * @param db - The database.
 * @param request - The practice, the draft, the line and its new fields.
 * @returns The draft as changed.
 * @throws PracticeError naming each field at fault, or `stale` when the line is no longer in the draft.
 */
export async function editDraftLine(
  db: Database["db"],
  request: z.input<typeof editRequest>,
): Promise<EstimateVersionView> {
  const { practiceId, versionId, lineId, ...fields } = parsePracticeRequest(editRequest, request);
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, practiceId, versionId);
    const at = draft.lines.findIndex((line) => line.id === lineId);
    if (at < 0) {
      throw new PracticeError("stale", "That line changed since the page was opened.");
    }
    await refuseApprovedLine(tx, practiceId, draft, at);
    const lines = linesOf(draft).map((line, index) =>
      index === at ? withFields(line, fields) : line,
    );
    return replaceDraftLines(tx, { practiceId, versionId, actor: "vet", lines });
  });
}

/**
 * Takes one line out of a draft, written by the vet.
 *
 * @param db - The database.
 * @param request - The practice, the draft and the line.
 * @returns The draft as changed.
 * @throws PracticeError `stale` when the line is no longer in the draft.
 */
export async function removeDraftLine(
  db: Database["db"],
  request: z.input<typeof removeRequest>,
): Promise<EstimateVersionView> {
  const { practiceId, versionId, lineId } = parsePracticeRequest(removeRequest, request);
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, practiceId, versionId);
    const at = draft.lines.findIndex((line) => line.id === lineId);
    if (at < 0) {
      throw new PracticeError("stale", "That line changed since the page was opened.");
    }
    await refuseApprovedLine(tx, practiceId, draft, at);
    const lines = linesOf(draft).filter((_, index) => draft.lines[index]!.id !== lineId);
    return replaceDraftLines(tx, { practiceId, versionId, actor: "vet", lines });
  });
}

/**
 * Adds an item from the practice's list by hand (section 6: "Add items from
 * your price list"), written by the vet: to the open draft, or, with none
 * open, to a new draft, which for a held case starts from the version the
 * owner last approved (an update by hand).
 *
 * @param db - The database.
 * @param request - The practice, the case, the item's code and its quantities, condition and wording.
 * @returns The draft as changed.
 * @throws PracticeError naming each field at fault, or `stale` when the case is in no state to change its estimate.
 */
export async function addDraftLine(
  db: Database["db"],
  request: z.input<typeof addRequest>,
): Promise<EstimateVersionView> {
  const { practiceId, caseId, code, ...fields } = parsePracticeRequest(addRequest, request);
  return db.transaction(async (tx) => {
    const [kase] = await tx
      .select({ moneyState: patientCase.moneyState })
      .from(patientCase)
      .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)))
      .for("update");
    if (!kase) {
      throw new PracticeError("case_not_found", "That case is not this practice's.");
    }
    const list = await currentPriceList(tx, practiceId);
    if (!list?.items.has(code)) {
      throw new PracticeError("request_invalid", `${code} is not on the price list`, {
        code: "Choose an item from your price list",
      });
    }
    const added = withFields({ code, quantityLow: 0, quantityHigh: 1 }, fields);
    const versions = await caseEstimateVersions(tx, practiceId, caseId);
    const open = versions.find((version) => version.sentAt === null);
    if (open) {
      return replaceDraftLines(tx, {
        practiceId,
        versionId: open.id,
        actor: "vet",
        lines: [...linesOf(open), added],
      });
    }
    refuseUnlessDraftable(kase.moneyState);
    const money = await caseMoney(tx, practiceId, caseId);
    const base = approvedVersions(
      versions.filter((version) => version.sentAt !== null),
      money.holds,
    ).at(-1);
    const startFrom = UPDATE_OPEN.includes(kase.moneyState) && base ? linesOf(base) : [];
    return makeEstimateVersion(tx, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [...startFrom, added],
    });
  });
}

/**
 * Refuses a new draft while an estimate is with the owner or the case is
 * discharged.
 *
 * @param state - The case's money state.
 * @throws PracticeError `stale`.
 */
function refuseUnlessDraftable(state: MoneyState): void {
  if (state === "awaiting_owner" || state === "update_awaiting_owner") {
    throw new PracticeError(
      "stale",
      "The estimate is with the owner. Withdraw it before changing it.",
    );
  }
  if (state === "withdrawn") {
    throw new PracticeError("stale", "Draft the withdrawn estimate again before changing it.");
  }
  if (!["estimate_draft", ...UPDATE_OPEN].includes(state)) {
    throw new PracticeError("stale", "The case is discharged: its estimate no longer changes.");
  }
}

const versionRequest = z.strictObject({
  practiceId: z.uuid(),
  versionId: z.uuid(),
  /** What the review dialog showed: the totals and the lines, by id. */
  reviewed: z
    .strictObject({
      lowPence: z.int(),
      highPence: z.int(),
      lineIds: z.array(z.uuid()),
    })
    .optional(),
});

/**
 * Review and send (section 6): the vet's approval of exactly what the review
 * showed, an audit event with the vet's name and the totals approved (plan
 * 3.4: "nothing reaches the owner unreviewed"), then U3's send, which moves
 * the case, in one transaction holding the case's lock. A draft changed since
 * the review (any change rewrites its lines' ids, U2) is refused as stale; a
 * refused send writes no approval.
 *
 * @param db - The database.
 * @param request - The practice, the draft and what the review showed of it.
 * @returns The version as sent and the case's new state.
 * @throws PracticeError when the version is not the practice's, changed since the review, or its case names no vet.
 * @throws EstimateError or MoneyError as U2's and U3's send refuse.
 */
export async function approveAndSend(
  db: Database["db"],
  request: z.input<typeof versionRequest>,
): Promise<SentEstimate> {
  const { practiceId, versionId, reviewed } = parsePracticeRequest(versionRequest, request);
  return db.transaction(async (tx) => {
    const found = await loadEstimateVersion(tx, practiceId, versionId);
    if (!found) {
      throw new PracticeError("version_not_found", "That estimate is not this practice's.");
    }
    const [kase] = await tx
      .select({ vetName: patientCase.vetName })
      .from(patientCase)
      .where(eq(patientCase.id, found.caseId))
      .for("update");
    const version = (await loadEstimateVersion(tx, practiceId, versionId))!;
    if (
      reviewed &&
      (reviewed.lowPence !== version.totals.lowPence ||
        reviewed.highPence !== version.totals.highPence ||
        reviewed.lineIds.join() !== version.lines.map((line) => line.id).join())
    ) {
      throw new PracticeError(
        "stale",
        "The draft changed since you reviewed it. Review it again before sending.",
      );
    }
    if (!kase?.vetName) {
      throw new PracticeError(
        "request_invalid",
        "The case names no vet, so the estimate cannot be approved.",
      );
    }
    await appendAuditEvent(tx, {
      practiceId,
      caseId: version.caseId,
      actor: "vet",
      action: "estimate.approved",
      detail: {
        versionId,
        number: version.number,
        vetName: kase.vetName,
        lowPence: version.totals.lowPence,
        highPence: version.totals.highPence,
        lineCount: version.lines.length,
      },
    });
    return sendEstimate(tx, { practiceId, versionId, actor: "vet" });
  });
}

const caseRequest = z.strictObject({ practiceId: z.uuid(), caseId: z.uuid() });

/**
 * Withdraws the estimate awaiting the owner (U3's `withdrawEstimate`, by the vet).
 *
 * @param db - The database.
 * @param request - The practice and the case.
 * @returns The case's new state.
 * @throws MoneyError when no estimate awaits the owner.
 */
export async function withdrawCaseEstimate(
  db: Database["db"],
  request: z.input<typeof caseRequest>,
): Promise<MoneyState> {
  const { practiceId, caseId } = parsePracticeRequest(caseRequest, request);
  return withdrawEstimate(db, { practiceId, caseId, actor: "vet" });
}

/**
 * Starts a new draft from a withdrawn estimate, its lines and the notes they
 * came from, so it can be changed and sent again (U3: "a withdrawn estimate
 * may be sent again"). The agent does not draft again once an estimate was
 * sent (U4), so the vet changes it by hand.
 *
 * @param db - The database.
 * @param request - The practice and the case.
 * @returns The new draft.
 * @throws PracticeError `stale` when the case's estimate is not withdrawn, or a draft is open.
 */
export async function draftAgainFromWithdrawn(
  db: Database["db"],
  request: z.input<typeof caseRequest>,
): Promise<EstimateVersionView> {
  const { practiceId, caseId } = parsePracticeRequest(caseRequest, request);
  return db.transaction(async (tx) => {
    const [kase] = await tx
      .select({ moneyState: patientCase.moneyState })
      .from(patientCase)
      .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)))
      .for("update");
    if (kase?.moneyState !== "withdrawn") {
      throw new PracticeError("stale", "Only a withdrawn estimate is drafted again.");
    }
    const versions = await caseEstimateVersions(tx, practiceId, caseId);
    if (versions.some((version) => version.sentAt === null)) {
      throw new PracticeError("stale", "A draft is open already.");
    }
    const withdrawn = versions.at(-1)!;
    const draft = await makeEstimateVersion(tx, {
      practiceId,
      caseId,
      actor: "vet",
      lines: linesOf(withdrawn),
    });
    const [source] = await tx
      .select()
      .from(estimateSource)
      .where(eq(estimateSource.versionId, withdrawn.id));
    if (source) {
      await tx.insert(estimateSource).values({
        versionId: draft.id,
        practiceId,
        caseId,
        kind: source.kind,
        text: source.text,
        unmatched: source.unmatched,
        unsupported: source.unsupported,
      });
    }
    return draft;
  });
}
