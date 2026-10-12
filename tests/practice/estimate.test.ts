import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { draftRequest } from "@/agent/draft";
import { createRecordedModel, memoryRecordedStore, type RecordedStore } from "@/agent/recorded";
import { DRAFT_FAILED } from "@/agent/wording";
import { auditEvent, estimateSource, practice } from "@/db/schema";
import { currentPriceList, importPriceList, type PriceListWithItems } from "@/estimate/price-list";
import { EstimateError } from "@/estimate/version";
import { openCase } from "@/practice/cases";
import { PracticeError } from "@/practice/errors";
import {
  addDraftLine,
  approveAndSend,
  draftAgainFromWithdrawn,
  draftForCase,
  editDraftLine,
  loadCaseView,
  removeDraftLine,
  withdrawCaseEstimate,
} from "@/practice/estimate";

import { readSeedPriceList } from "../../seed/practice";
import { failingModel, primeAnswer } from "../support/agent";
import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();

/** Plan 3.4's own example of a vet's notes, with a phrase no item matches. */
const NOTES =
  "GA, dental scale and polish, probable two extractions upper PM, pre-op bloods, buster collar";

const ANSWER = {
  lines: [
    {
      code: "GA-DENT",
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: null,
      notesSpan: "GA",
      ownerWording: "A general anaesthetic for the dental work",
    },
    {
      code: "DEN-SP",
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: null,
      notesSpan: "dental scale and polish",
      ownerWording: "Cleaning and polishing the teeth",
    },
    {
      code: "DEN-EXT-SG",
      quantityLow: 0,
      quantityHigh: 2,
      dependsOn: "extractions are needed",
      notesSpan: "probable two extractions upper PM",
      ownerWording: "Removing up to two teeth, if needed",
    },
    {
      code: "LAB-PRE",
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: null,
      notesSpan: "pre-op bloods",
      ownerWording: "A blood test before the anaesthetic",
    },
    {
      code: "MED-OPIOID",
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: null,
      notesSpan: "opioid for pain",
      ownerWording: "Pain relief",
    },
  ],
  unmatched: [{ notesSpan: "buster collar" }],
};

let practiceId: string;
let caseId: string;
let list: PriceListWithItems;
let store: RecordedStore;

beforeEach(async () => {
  const [made] = await db
    .insert(practice)
    .values({ name: "Estimate practice", kind: "judge" })
    .returning();
  practiceId = made!.id;
  await importPriceList(db, {
    practiceId,
    actor: "system",
    sourceName: "seed/practice/price-list.csv",
    csv: readSeedPriceList(),
  });
  list = (await currentPriceList(db, practiceId))!;
  caseId = await openCase(db, {
    practiceId,
    patientName: "Biscuit",
    ownerName: "Sam Owner",
    procedure: "Dental",
    vetName: "Rowan Hale",
  });
  store = memoryRecordedStore();
  primeAnswer(store, draftRequest(list.items.values(), NOTES), ANSWER);
});

/**
 * The agent's dependencies on the recorded double.
 *
 * @returns The dependencies.
 */
function agent() {
  return { db, model: createRecordedModel(store), draftsPerHour: null };
}

describe("drafting from the notes", () => {
  it("keeps the notes and what the draft made of them beside the draft, each line's span found in them", async () => {
    await draftForCase(agent(), { practiceId, caseId, notes: NOTES });

    const view = await loadCaseView(db, practiceId, caseId);
    const draft = view.estimate.draft!;
    expect(draft.version.lines.map((line) => line.code)).toEqual([
      "GA-DENT",
      "DEN-SP",
      "DEN-EXT-SG",
      "LAB-PRE",
    ]);
    expect(draft.source?.text).toBe(NOTES);
    expect(draft.spans).toEqual([
      { position: 1, start: 0, end: 2 },
      { position: 2, start: 4, end: 27 },
      { position: 3, start: 29, end: 62 },
      { position: 4, start: 64, end: 77 },
    ]);
    expect(draft.source?.unmatched.map((one) => one.notesSpan)).toEqual(["buster collar"]);
    expect(draft.source?.unsupported.map((one) => one.notesSpan)).toEqual(["opioid for pain"]);
    expect(draft.source?.failure).toBeNull();
  });

  it("leaves the empty estimate and says why when the model fails", async () => {
    await draftForCase(
      { db, model: failingModel("unavailable"), draftsPerHour: null },
      { practiceId, caseId, notes: NOTES },
    );

    const { draft } = (await loadCaseView(db, practiceId, caseId)).estimate;
    expect(draft?.version.lines).toEqual([]);
    expect(draft?.source?.failure?.reason).toBe("unavailable");
    expect(draft?.source?.text).toBe(NOTES);
    expect(DRAFT_FAILED).toBe(
      "The draft didn't work this time. Add items from your price list below.",
    );
  });

  it("keeps the earlier notes beside the lines they came from when a redraft fails", async () => {
    await draftForCase(agent(), { practiceId, caseId, notes: NOTES });

    await draftForCase(
      { db, model: failingModel("unavailable"), draftsPerHour: null },
      { practiceId, caseId, notes: "something else entirely" },
    );

    const { draft } = (await loadCaseView(db, practiceId, caseId)).estimate;
    expect(draft?.version.lines).toHaveLength(4);
    expect(draft?.source?.text).toBe(NOTES);
    expect(draft?.source?.failure?.reason).toBe("unavailable");
  });

  it("clears an earlier failure when a redraft works", async () => {
    await draftForCase(
      { db, model: failingModel("unavailable"), draftsPerHour: null },
      { practiceId, caseId, notes: NOTES },
    );
    await draftForCase(agent(), { practiceId, caseId, notes: NOTES });

    const { draft } = (await loadCaseView(db, practiceId, caseId)).estimate;
    expect(draft?.source?.failure).toBeNull();
    expect(draft?.version.lines).toHaveLength(4);
  });
});

describe("editing the draft", () => {
  beforeEach(async () => {
    await draftForCase(agent(), { practiceId, caseId, notes: NOTES });
  });

  it("changes a line's quantities, condition and wording, repriced by U2 and written by the vet", async () => {
    const before = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;
    const extraction = before.lines.find((line) => line.code === "DEN-EXT-SG")!;

    await editDraftLine(db, {
      practiceId,
      versionId: before.id,
      lineId: extraction.id,
      quantityLow: 1,
      quantityHigh: 3,
      dependsOn: "the radiographs show it",
      ownerWording: "Removing up to three teeth",
    });

    const after = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;
    const edited = after.lines.find((line) => line.code === "DEN-EXT-SG")!;
    expect(edited).toMatchObject({
      position: extraction.position,
      quantityLow: 1,
      quantityHigh: 3,
      dependsOn: "the radiographs show it",
      ownerWording: "Removing up to three teeth",
      notesSpan: extraction.notesSpan,
      lowPence: 9_800,
      highPence: 29_400,
    });
    expect(after.totals.highPence - before.totals.highPence).toBe(9_800);
    const [changed] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.draft_changed")))
      .orderBy(asc(auditEvent.id));
    expect(changed?.actor).toBe("vet");
  });

  it("refuses an owner's wording with an amount, a percentage or a dose, naming the field", async () => {
    const draft = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;

    const refused = await editDraftLine(db, {
      practiceId,
      versionId: draft.id,
      lineId: draft.lines[0]!.id,
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: "",
      ownerWording: "Anaesthetic, about £300",
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PracticeError);
    expect((refused as PracticeError).fields.ownerWording).toBe(
      "The owner's wording can't carry an amount, a percentage or a dose: prices come from your list.",
    );
  });

  it("refuses a low quantity above the high one, naming the field", async () => {
    const draft = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;
    const refused = await editDraftLine(db, {
      practiceId,
      versionId: draft.id,
      lineId: draft.lines[0]!.id,
      quantityLow: 3,
      quantityHigh: 2,
      dependsOn: "",
      ownerWording: "",
    }).catch((error: unknown) => error);

    expect((refused as PracticeError).fields).toHaveProperty("quantityLow");
  });

  it("refuses an edit to a line that is no longer in the draft as stale", async () => {
    const draft = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;
    await removeDraftLine(db, { practiceId, versionId: draft.id, lineId: draft.lines[0]!.id });

    const refused = await editDraftLine(db, {
      practiceId,
      versionId: draft.id,
      lineId: draft.lines[0]!.id,
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: "",
      ownerWording: "",
    }).catch((error: unknown) => error);

    expect((refused as PracticeError).reason).toBe("stale");
  });

  it("adds an item from the list by hand and removes a line", async () => {
    await addDraftLine(db, {
      practiceId,
      caseId,
      code: "CONS-COLLAR",
      quantityLow: 1,
      quantityHigh: 1,
    });
    // Each change rewrites the draft's lines, so the page reads them again before the next.
    const draft = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;
    await removeDraftLine(db, {
      practiceId,
      versionId: draft.id,
      lineId: draft.lines.find((line) => line.code === "LAB-PRE")!.id,
    });

    const lines = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version.lines;
    expect(lines.map((line) => line.code)).toEqual([
      "GA-DENT",
      "DEN-SP",
      "DEN-EXT-SG",
      "CONS-COLLAR",
    ]);
    expect(lines.at(-1)?.notesSpan).toBeNull();
  });

  it("refuses an item not on the list, naming the field", async () => {
    const refused = await addDraftLine(db, {
      practiceId,
      caseId,
      code: "NOT-THERE",
      quantityLow: 1,
      quantityHigh: 1,
    }).catch((error: unknown) => error);

    expect((refused as PracticeError).fields).toHaveProperty("code");
  });
});

describe("a case with no draft", () => {
  it("starts its estimate by hand with the first item added", async () => {
    await addDraftLine(db, {
      practiceId,
      caseId,
      code: "CON-STD",
      quantityLow: 1,
      quantityHigh: 1,
    });

    const { draft } = (await loadCaseView(db, practiceId, caseId)).estimate;
    expect(draft?.version.number).toBe(1);
    expect(draft?.version.lines.map((line) => line.code)).toEqual(["CON-STD"]);
    expect(draft?.source).toBeNull();
  });
});

describe("review and send", () => {
  beforeEach(async () => {
    await draftForCase(agent(), { practiceId, caseId, notes: NOTES });
  });

  it("records the vet's approval with the vet's name, then sends, in one go (plan 3.4)", async () => {
    const draft = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;

    const sent = await approveAndSend(db, { practiceId, versionId: draft.id });

    expect(sent.moneyState).toBe("awaiting_owner");
    const events = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.caseId, caseId))
      .orderBy(asc(auditEvent.id));
    const [approved, sentEvent] = events.slice(-2);
    expect(approved).toMatchObject({
      actor: "vet",
      action: "estimate.approved",
      detail: { versionId: draft.id, number: 1, vetName: "Rowan Hale" },
    });
    expect(sentEvent).toMatchObject({
      actor: "vet",
      action: "estimate.sent",
      moneyStateBefore: "estimate_draft",
      moneyStateAfter: "awaiting_owner",
      amountPence: draft.totals.highPence,
    });
    const view = await loadCaseView(db, practiceId, caseId);
    expect(view.estimate.draft).toBeNull();
    expect(view.estimate.sent?.version.id).toBe(draft.id);
    expect(view.estimate.sent?.source?.text).toBe(NOTES);
  });

  it("writes no approval when the send is refused", async () => {
    const draft = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;
    for (;;) {
      const [first] = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version.lines;
      if (!first) {
        break;
      }
      await removeDraftLine(db, { practiceId, versionId: draft.id, lineId: first.id });
    }

    await expect(approveAndSend(db, { practiceId, versionId: draft.id })).rejects.toBeInstanceOf(
      EstimateError,
    );
    const approvals = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.approved")));
    expect(approvals).toEqual([]);
  });

  it("withdraws the estimate awaiting the owner, and drafts it again from what was withdrawn", async () => {
    const draft = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;
    await approveAndSend(db, { practiceId, versionId: draft.id });

    expect(await withdrawCaseEstimate(db, { practiceId, caseId })).toBe("withdrawn");
    await draftAgainFromWithdrawn(db, { practiceId, caseId });

    const view = await loadCaseView(db, practiceId, caseId);
    expect(view.money.state).toBe("withdrawn");
    expect(view.estimate.draft?.version.number).toBe(2);
    expect(view.estimate.draft?.version.lines.map((line) => line.code)).toEqual(
      draft.lines.map((line) => line.code),
    );
    expect(view.estimate.draft?.source?.text).toBe(NOTES);
    const sources = await db.select().from(estimateSource).where(eq(estimateSource.caseId, caseId));
    expect(sources).toHaveLength(2);
  });

  it("refuses to send when the draft changed since the vet reviewed it, and records what was approved", async () => {
    const reviewed = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;
    await addDraftLine(db, {
      practiceId,
      caseId,
      code: "CONS-COLLAR",
      quantityLow: 1,
      quantityHigh: 1,
    });

    const refused = await approveAndSend(db, {
      practiceId,
      versionId: reviewed.id,
      reviewed: reviewedOf(reviewed),
    }).catch((error: unknown) => error);
    expect((refused as PracticeError).reason).toBe("stale");

    const now = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;
    await approveAndSend(db, { practiceId, versionId: now.id, reviewed: reviewedOf(now) });
    const [approved] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.approved")));
    expect(approved?.detail).toMatchObject({
      lowPence: now.totals.lowPence,
      highPence: now.totals.highPence,
      lineCount: now.lines.length,
    });
  });
});

describe("a line's fields", () => {
  beforeEach(async () => {
    await draftForCase(agent(), { practiceId, caseId, notes: NOTES });
  });

  it("refuse a blank or odd quantity rather than reading it as 0, in words a vet reads", async () => {
    const draft = (await loadCaseView(db, practiceId, caseId)).estimate.draft!.version;
    for (const quantityLow of ["", " ", "1e1", "0x10", "+3"]) {
      const refused = await editDraftLine(db, {
        practiceId,
        versionId: draft.id,
        lineId: draft.lines[0]!.id,
        quantityLow,
        quantityHigh: "1",
        dependsOn: "",
        ownerWording: "",
      }).catch((error: unknown) => error);
      expect((refused as PracticeError).fields.quantityLow, quantityLow).toBe(
        "Enter a whole number",
      );
      expect((refused as PracticeError).message).toBe("Check the fields marked below.");
    }
  });
});

/**
 * What the review dialog showed of a draft.
 *
 * @param version - The draft as rendered.
 * @returns Its totals and its lines.
 */
function reviewedOf(version: {
  totals: { lowPence: number; highPence: number };
  lines: readonly { id: string }[];
}) {
  return {
    lowPence: version.totals.lowPence,
    highPence: version.totals.highPence,
    lineIds: version.lines.map((line) => line.id),
  };
}
