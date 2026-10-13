import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { draftEstimate, draftRequest } from "@/agent/draft";
import { MODEL_SETTINGS, requestHash } from "@/agent/model";
import { createRecordedModel, memoryRecordedStore, type RecordedStore } from "@/agent/recorded";
import { auditEvent, patientCase, practice } from "@/db/schema";
import { currentPriceList, importPriceList, type PriceListWithItems } from "@/estimate/price-list";
import {
  EstimateError,
  makeEstimateVersion,
  replaceDraftLines,
  sendEstimateVersion,
} from "@/estimate/version";

import { readSeedPriceList } from "../../seed/practice";
import { countingModel, failingModel, primeAnswer } from "../support/agent";
import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();

/** Plan 3.4's own example of a vet's notes. */
const NOTES = "GA, dental scale and polish, probable two extractions upper PM, pre-op bloods";

const GOOD_LINES = [
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
];

let practiceId: string;
let caseId: string;
let list: PriceListWithItems;
let store: RecordedStore;

beforeEach(async () => {
  const [made] = await db
    .insert(practice)
    .values({ name: "Draft practice", kind: "judge" })
    .returning();
  practiceId = made!.id;
  await importPriceList(db, {
    practiceId,
    actor: "system",
    sourceName: "seed/practice/price-list.csv",
    csv: readSeedPriceList(),
  });
  const [kase] = await db
    .insert(patientCase)
    .values({
      practiceId,
      patientName: "Biscuit",
      species: "dog",
      ownerName: "Sam Owner",
      procedure: "Dental",
    })
    .returning();
  caseId = kase!.id;
  list = (await currentPriceList(db, practiceId))!;
  store = memoryRecordedStore();
});

/**
 * Records the model's answer to plan 3.4's notes.
 *
 * @param answer - The answer.
 * @param notes - The notes, when not 3.4's.
 */
function answerWith(answer: unknown, notes = NOTES): void {
  primeAnswer(store, draftRequest(list.items.values(), notes), answer);
}

describe("drafting an estimate from the notes", () => {
  it("makes a draft version whose every line is priced from the list", async () => {
    answerWith({ lines: GOOD_LINES, unmatched: [] });

    const drafted = await draftEstimate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, notes: NOTES },
    );

    expect(drafted.failure).toBeNull();
    expect(drafted.version.sentAt).toBeNull();
    expect(drafted.version.lines.map((line) => [line.code, line.unitPricePence])).toEqual([
      ["GA-DENT", 32_000],
      ["DEN-SP", 18_500],
      ["DEN-EXT-SG", 9_800],
      ["LAB-PRE", 7_200],
    ]);
    expect(drafted.version.totals).toEqual({
      lowPence: 32_000 + 18_500 + 7_200,
      highPence: 32_000 + 18_500 + 2 * 9_800 + 7_200,
    });
    expect(drafted.version.lines[2]).toMatchObject({
      quantityLow: 0,
      quantityHigh: 2,
      dependsOn: "extractions are needed",
      notesSpan: "probable two extractions upper PM",
      ownerWording: "Removing up to two teeth, if needed",
    });
    expect(drafted.lines.map((line) => [line.position, line.start, line.end])).toEqual([
      [1, 0, 2],
      [2, 4, 27],
      [3, 29, 62],
      [4, 64, 77],
    ]);
  });

  it("asks with the price list in the instructions and the notes as the input", () => {
    const request = draftRequest(list.items.values(), NOTES);
    expect(request).toMatchObject({ job: "draft", promptVersion: "draft.v1", input: NOTES });
    expect(request.instructions).toContain("DEN-EXT-SG | Tooth extraction, surgical | procedure");
    expect(request.instructions).not.toMatch(/9800|98\.00/);
  });

  // Plan 5, U4's acceptance: "a code not in the list is dropped and its span shown as unmatched".
  it("drops a code not in the list and shows its span as unmatched", async () => {
    answerWith({
      lines: [GOOD_LINES[0], { ...GOOD_LINES[2], code: "DEN-EXT-PM" }],
      unmatched: [],
    });

    const drafted = await draftEstimate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, notes: NOTES },
    );

    expect(drafted.version.lines.map((line) => line.code)).toEqual(["GA-DENT"]);
    expect(drafted.unmatched).toEqual([
      { notesSpan: "probable two extractions upper PM", start: 29, end: 62, code: "DEN-EXT-PM" },
    ]);
  });

  // Plan 5, U4's acceptance: "a line whose span is not in the notes is dropped".
  it("drops a line whose span is not in the notes", async () => {
    answerWith({
      lines: [...GOOD_LINES, { ...GOOD_LINES[3], code: "IMG-XR-DENT", notesSpan: "dental x-rays" }],
      unmatched: [],
    });

    const drafted = await draftEstimate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, notes: NOTES },
    );

    expect(drafted.version.lines.map((line) => line.code)).not.toContain("IMG-XR-DENT");
    expect(drafted.unsupported).toEqual([
      expect.objectContaining({ reason: "span_not_in_notes", notesSpan: "dental x-rays" }),
    ]);
  });

  // Plan 5, U4's acceptance: "an owner's wording with a currency amount, a
  // percentage or a dose falls back to the item's own name".
  it("stores the item's own name where the owner's wording carried an amount", async () => {
    answerWith({
      lines: [{ ...GOOD_LINES[3], ownerWording: "Blood test, £72.00" }],
      unmatched: [],
    });

    const drafted = await draftEstimate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, notes: NOTES },
    );

    expect(drafted.version.lines[0]?.ownerWording).toBe("Pre-anaesthetic blood screen");
    expect(drafted.lines[0]?.ownerWordingFellBack).toBe("currency");
  });
});

describe("a model error", () => {
  // Plan 5, U4's acceptance: "a model error leaves an empty estimate the vet can fill by hand".
  it.each([
    ["no recorded answer", null, "not_recorded"],
    ["an answer that is not JSON", '{"lines": [', "malformed"],
    ["an answer outside the schema", { lines: "none" }, "malformed"],
  ])("leaves an empty estimate the vet can fill by hand: %s", async (_case, answer, reason) => {
    if (answer !== null) {
      answerWith(answer);
    }

    const drafted = await draftEstimate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, notes: NOTES },
    );

    expect(drafted.failure?.reason).toBe(reason);
    expect(drafted.version.lines).toEqual([]);
    expect(drafted.version.sentAt).toBeNull();

    const filled = await replaceDraftLines(db, {
      practiceId,
      versionId: drafted.version.id,
      actor: "vet",
      lines: [{ code: "DEN-SP", quantityLow: 1, quantityHigh: 1 }],
    });
    expect(filled.totals).toEqual({ lowPence: 18_500, highPence: 18_500 });
  });

  it.each(["refused", "truncated", "provider", "transport", "unavailable"] as const)(
    "leaves an empty estimate when the model is %s",
    async (reason) => {
      const drafted = await draftEstimate(
        { db, model: failingModel(reason) },
        { practiceId, caseId, notes: NOTES },
      );
      expect(drafted.failure?.reason).toBe(reason);
      expect(drafted.version.lines).toEqual([]);
    },
  );
});

describe("the draft's audit event", () => {
  it("records the model id, the input's hash and the validated output", async () => {
    answerWith({ lines: GOOD_LINES, unmatched: [{ notesSpan: "upper PM" }] });

    const drafted = await draftEstimate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, notes: NOTES },
    );

    const events = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.drafted")));
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      actor: "system",
      modelId: "gpt-6.1-sol",
      modelInputSha256: requestHash(MODEL_SETTINGS, draftRequest(list.items.values(), NOTES)),
    });
    expect(event!.modelOutput).toMatchObject({
      servedModel: "gpt-6.1-sol",
      failure: null,
      answer: { lines: GOOD_LINES, unmatched: [{ notesSpan: "upper PM" }] },
      kept: ["GA-DENT", "DEN-SP", "DEN-EXT-SG", "LAB-PRE"],
      unmatched: [{ notesSpan: "upper PM", start: 54, end: 62, code: null }],
      unsupported: [],
    });
    expect(event!.detail).toMatchObject({
      versionId: drafted.version.id,
      promptVersion: "draft.v1",
      source: "model",
    });
  });

  it("records a model error with no answer", async () => {
    await draftEstimate(
      { db, model: failingModel("refused") },
      { practiceId, caseId, notes: NOTES },
    );
    const [event] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.drafted")));
    expect(event!.modelOutput).toMatchObject({
      answer: null,
      failure: { reason: "refused" },
    });
  });
});

describe("what is refused before the model is asked", () => {
  it("refuses a practice with no price list", async () => {
    const [bare] = await db.insert(practice).values({ name: "Bare", kind: "judge" }).returning();
    const [kase] = await db
      .insert(patientCase)
      .values({
        practiceId: bare!.id,
        patientName: "Rex",
        species: "dog",
        ownerName: "A. Owner",
        procedure: "X",
      })
      .returning();
    const counted = countingModel(createRecordedModel(store));

    const error = await draftEstimate(
      { db, model: counted.model },
      { practiceId: bare!.id, caseId: kase!.id, notes: NOTES },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EstimateError);
    expect((error as EstimateError).reason).toBe("no_price_list");
    expect(counted.calls).toEqual([]);
  });

  it("refuses a case whose estimate was sent: an update is the way to change it", async () => {
    const first = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [{ code: "DEN-SP", quantityLow: 1, quantityHigh: 1 }],
    });
    await sendEstimateVersion(db, { practiceId, versionId: first.id, actor: "vet" });
    const counted = countingModel(createRecordedModel(store));

    const error = await draftEstimate(
      { db, model: counted.model },
      { practiceId, caseId, notes: NOTES },
    ).catch((caught: unknown) => caught);

    expect((error as EstimateError).reason).toBe("sent");
    expect(counted.calls).toEqual([]);
  });

  it("redrafts an open first draft the vet made, leaving it as it was if the model fails", async () => {
    const open = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [{ code: "DEN-SP", quantityLow: 1, quantityHigh: 1 }],
    });

    const failed = await draftEstimate(
      { db, model: failingModel("transport") },
      { practiceId, caseId, notes: NOTES },
    );
    expect(failed.version.id).toBe(open.id);
    expect(failed.version.lines.map((line) => line.code)).toEqual(["DEN-SP"]);

    answerWith({ lines: GOOD_LINES, unmatched: [] });
    const redrafted = await draftEstimate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, notes: NOTES },
    );
    expect(redrafted.version.id).toBe(open.id);
    expect(redrafted.version.lines).toHaveLength(4);
  });

  it("refuses another practice's case", async () => {
    const [other] = await db.insert(practice).values({ name: "Other", kind: "judge" }).returning();
    const error = await draftEstimate(
      { db, model: createRecordedModel(store) },
      { practiceId: other!.id, caseId, notes: NOTES },
    ).catch((caught: unknown) => caught);
    expect((error as EstimateError).reason).toBe("case_not_found");
  });

  it.each([
    ["empty notes", "   "],
    ["notes over 10,000 characters", "x".repeat(10_001)],
  ])("refuses %s", async (_case, notes) => {
    const error = await draftEstimate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, notes },
    ).catch((caught: unknown) => caught);
    expect((error as EstimateError).reason).toBe("request_invalid");
  });
});

describe("what happens after the model is asked (the review's findings, 12 October)", () => {
  it("audits the ask when the write is then refused: the draft was sent meanwhile", async () => {
    answerWith({ lines: GOOD_LINES, unmatched: [] });
    const open = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [{ code: "DEN-SP", quantityLow: 1, quantityHigh: 1 }],
    });
    const recorded = createRecordedModel(store);
    const sendsMeanwhile = {
      settings: recorded.settings,
      answer: async (request: Parameters<typeof recorded.answer>[0]) => {
        await sendEstimateVersion(db, { practiceId, versionId: open.id, actor: "vet" });
        return recorded.answer(request);
      },
    };

    const error = await draftEstimate(
      { db, model: sendsMeanwhile },
      { practiceId, caseId, notes: NOTES },
    ).catch((caught: unknown) => caught);

    expect((error as EstimateError).reason).toBe("sent");
    const [event] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.drafted")));
    expect(event).toMatchObject({
      modelId: "gpt-6.1-sol",
      modelInputSha256: requestHash(MODEL_SETTINGS, draftRequest(list.items.values(), NOTES)),
    });
    expect(event!.detail).toMatchObject({ versionId: null, source: "model", refused: "sent" });
  });

  it("takes two presses at once as a draft and its redraft", async () => {
    answerWith({ lines: GOOD_LINES, unmatched: [] });
    const model = createRecordedModel(store);

    const [first, second] = await Promise.all([
      draftEstimate({ db, model }, { practiceId, caseId, notes: NOTES }),
      draftEstimate({ db, model }, { practiceId, caseId, notes: NOTES }),
    ]);

    expect(second.version.id).toBe(first.version.id);
    expect(second.version.lines).toHaveLength(4);
  });

  it("refuses a case in another currency than the list before the model is asked", async () => {
    const [kase] = await db
      .insert(patientCase)
      .values({
        practiceId,
        patientName: "Rex",
        species: "dog",
        ownerName: "A. Owner",
        procedure: "X",
        currencyCode: "USD",
      })
      .returning();
    const counted = countingModel(createRecordedModel(store));

    const error = await draftEstimate(
      { db, model: counted.model },
      { practiceId, caseId: kase!.id, notes: NOTES },
    ).catch((caught: unknown) => caught);

    expect((error as EstimateError).reason).toBe("currency_mismatch");
    expect(counted.calls).toEqual([]);
  });

  it("records what the preserved draft holds when a redraft fails", async () => {
    await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [{ code: "DEN-SP", quantityLow: 1, quantityHigh: 1 }],
    });
    await draftEstimate(
      { db, model: failingModel("refused") },
      { practiceId, caseId, notes: NOTES },
    );
    const [event] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.drafted")));
    expect(event!.detail).toMatchObject({ draftedLines: 0, versionLines: 1, preserved: true });
  });
});
