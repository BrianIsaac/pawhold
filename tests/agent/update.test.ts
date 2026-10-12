import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { checkExplanation } from "@/agent/guardrails";
import { MODEL_SETTINGS, requestHash } from "@/agent/model";
import { createRecordedModel, memoryRecordedStore, type RecordedStore } from "@/agent/recorded";
import { draftUpdate, updateRequest } from "@/agent/update";
import { auditEvent, patientCase, practice } from "@/db/schema";
import { currentPriceList, importPriceList, type PriceListWithItems } from "@/estimate/price-list";
import {
  EstimateError,
  type EstimateVersionView,
  linesOf,
  makeEstimateVersion,
  sendEstimateVersion,
} from "@/estimate/version";

import { readSeedPriceList } from "../../seed/practice";
import { countingModel, failingModel, primeAnswer } from "../support/agent";
import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();

/** A vet's finding mid-procedure, in the shape plan 3.4's job 2 describes. */
const FINDING =
  "Under GA: upper left PM4 fractured with root exposure, needs surgical extraction. Also a fractured lower canine, recommend dental radiographs before deciding on extraction.";

const PHOTO = { mediaType: "image/png" as const, dataBase64: "iVBORw0KGgo=" };

const DELTA = [
  {
    code: "DEN-EXT-SG",
    quantityLow: 1,
    quantityHigh: 1,
    dependsOn: null,
    notesSpan: "needs surgical extraction",
    ownerWording: "Surgically removing the broken upper tooth",
  },
  {
    code: "IMG-XR-DENT",
    quantityLow: 1,
    quantityHigh: 1,
    dependsOn: null,
    notesSpan: "recommend dental radiographs",
    ownerWording: "X-rays of the teeth",
  },
  {
    code: "DEN-EXT-SG",
    quantityLow: 0,
    quantityHigh: 1,
    dependsOn: "the x-rays show the canine must come out",
    notesSpan: "before deciding on extraction",
    ownerWording: "Removing the broken lower tooth, if needed",
  },
];

const EXPLANATION =
  "While Biscuit was under anaesthetic, the vet found a broken upper tooth with its root showing, which needs to be taken out. A lower tooth is also broken, and the vet recommends x-rays before deciding whether it needs to come out too.";

let practiceId: string;
let caseId: string;
let list: PriceListWithItems;
let sent: EstimateVersionView;
let store: RecordedStore;

beforeEach(async () => {
  const [made] = await db
    .insert(practice)
    .values({ name: "Update practice", kind: "judge" })
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
    .values({ practiceId, patientName: "Biscuit", ownerName: "Sam Owner", procedure: "Dental" })
    .returning();
  caseId = kase!.id;
  list = (await currentPriceList(db, practiceId))!;
  const draft = await makeEstimateVersion(db, {
    practiceId,
    caseId,
    actor: "vet",
    lines: [
      { code: "GA-DENT", quantityLow: 1, quantityHigh: 1, notesSpan: "GA" },
      { code: "DEN-SP", quantityLow: 1, quantityHigh: 1, notesSpan: "dental scale and polish" },
    ],
  });
  sent = await sendEstimateVersion(db, { practiceId, versionId: draft.id, actor: "vet" });
  store = memoryRecordedStore();
});

/**
 * Records the model's answer to the finding.
 *
 * @param answer - The answer.
 * @param photo - Whether the photo was sent.
 */
function answerWith(answer: unknown, photo: typeof PHOTO | null = null): void {
  primeAnswer(
    store,
    updateRequest({
      items: list.items.values(),
      patientName: "Biscuit",
      basedOn: sent,
      finding: FINDING,
      photo,
    }),
    answer,
  );
}

describe("drafting an update from the vet's finding", () => {
  it("makes the next version: the sent lines and the delta lines, priced from the list", async () => {
    answerWith({ lines: DELTA, explanation: EXPLANATION });

    const update = await draftUpdate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, finding: FINDING, photo: null },
    );

    expect(update.failure).toBeNull();
    expect(update.basedOn.id).toBe(sent.id);
    expect(update.version.number).toBe(2);
    expect(update.version.sentAt).toBeNull();
    expect(update.version.lines.map((line) => line.code)).toEqual([
      "GA-DENT",
      "DEN-SP",
      "DEN-EXT-SG",
      "IMG-XR-DENT",
      "DEN-EXT-SG",
    ]);
    expect(update.delta.totals).toEqual({ lowPence: 9_800 + 9_500, highPence: 2 * 9_800 + 9_500 });
    expect(update.lines.map((line) => line.position)).toEqual([3, 4, 5]);
    expect(update.lines[0]).toMatchObject({
      start: FINDING.indexOf("needs surgical"),
      end: FINDING.indexOf("needs surgical") + "needs surgical extraction".length,
    });
  });

  it("gives the owner's explanation beside the vet's own words", async () => {
    answerWith({ lines: DELTA, explanation: EXPLANATION });

    const update = await draftUpdate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, finding: FINDING, photo: null },
    );

    expect(update.explanation).toBe(EXPLANATION);
    expect(update.explanationFellBack).toBeNull();
    expect(update.vetNote).toBe(FINDING);
  });

  it("asks with the sent estimate and the finding as the input, the photo beside them", () => {
    const request = updateRequest({
      items: list.items.values(),
      patientName: "Biscuit",
      basedOn: sent,
      finding: FINDING,
      photo: PHOTO,
    });
    expect(request).toMatchObject({ job: "update", promptVersion: "update.v1", image: PHOTO });
    expect(request.input).toContain(FINDING);
    expect(request.input).toContain("Patient: Biscuit");
    expect(request.input).toContain("GA-DENT | General anaesthetic for dental work, first hour");
    expect(request.instructions).toContain("IMG-XR-DENT | Dental radiographs | imaging");
    expect(`${request.instructions}${request.input}`).not.toMatch(/32000|320\.00/);
  });

  it("checks the delta lines' spans against the vet's words, not the sent estimate", async () => {
    answerWith({
      lines: [{ ...DELTA[0], notesSpan: "dental scale and polish" }],
      explanation: EXPLANATION,
    });

    const update = await draftUpdate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, finding: FINDING, photo: null },
    );

    expect(update.version.lines).toHaveLength(2);
    expect(update.unsupported).toEqual([
      expect.objectContaining({
        reason: "span_not_in_notes",
        notesSpan: "dental scale and polish",
      }),
    ]);
  });

  it("drops a delta line whose code is not on the list and shows its span as unmatched", async () => {
    answerWith({
      lines: [{ ...DELTA[1], code: "IMG-CBCT" }],
      explanation: EXPLANATION,
    });

    const update = await draftUpdate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, finding: FINDING, photo: null },
    );

    expect(update.unmatched).toEqual([
      expect.objectContaining({ notesSpan: "recommend dental radiographs", code: "IMG-CBCT" }),
    ]);
  });

  it("falls back to the item's own name for an owner's wording with a dose", async () => {
    answerWith({
      lines: [{ ...DELTA[1], ownerWording: "X-rays, then 0.2 mg/kg pain relief" }],
      explanation: EXPLANATION,
    });

    const update = await draftUpdate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, finding: FINDING, photo: null },
    );

    expect(update.version.lines[2]?.ownerWording).toBe("Dental radiographs");
  });

  it("sends the photo with the request and records only its hash", async () => {
    answerWith({ lines: DELTA, explanation: EXPLANATION }, PHOTO);

    const update = await draftUpdate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, finding: FINDING, photo: PHOTO },
    );

    expect(update.failure).toBeNull();
    const [event] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.update_drafted")));
    expect(event!.detail).toMatchObject({
      photo: {
        mediaType: "image/png",
        sha256: createHash("sha256").update(Buffer.from(PHOTO.dataBase64, "base64")).digest("hex"),
        bytes: 8,
      },
    });
    expect(JSON.stringify(event)).not.toContain(PHOTO.dataBase64);
  });
});

describe("the owner's explanation", () => {
  it.each([
    ["an amount of money", "This will cost about £200 more.", "currency"],
    ["a percentage", "There is a 90% chance the tooth can be saved.", "percentage"],
    ["a dose", "Biscuit will have 0.2 mg/kg of pain relief.", "dose"],
    ["a number the vet did not write", "The vet found 3 broken teeth.", "new_number"],
    ["nothing at all", "   ", "empty"],
  ])("is not shown when it carries %s", async (_case, explanation, fault) => {
    expect(checkExplanation(explanation, FINDING)).toBe(fault);
    answerWith({ lines: DELTA, explanation });

    const update = await draftUpdate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, finding: FINDING, photo: null },
    );

    expect(update.explanation).toBeNull();
    expect(update.explanationFellBack).toBe(fault);
    expect(update.vetNote).toBe(FINDING);
    expect(update.version.lines).toHaveLength(5);
  });

  it("may repeat a number the vet wrote", () => {
    expect(checkExplanation("The upper PM4 tooth is broken.", FINDING)).toBeNull();
  });
});

describe("a model error during an update", () => {
  it("leaves a draft of the sent lines the vet adds to by hand, and no explanation", async () => {
    const update = await draftUpdate(
      { db, model: failingModel("refused") },
      { practiceId, caseId, finding: FINDING, photo: null },
    );

    expect(update.failure?.reason).toBe("refused");
    expect(update.version.lines.map((line) => line.code)).toEqual(["GA-DENT", "DEN-SP"]);
    expect(update.delta.items).toEqual([]);
    expect(update.explanation).toBeNull();
  });

  it("audits the call with the model id and the input's hash", async () => {
    await draftUpdate(
      { db, model: failingModel("transport") },
      { practiceId, caseId, finding: FINDING, photo: null },
    );
    const [event] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.update_drafted")));
    expect(event).toMatchObject({
      actor: "system",
      modelId: "gpt-6.1-sol",
      modelInputSha256: requestHash(
        MODEL_SETTINGS,
        updateRequest({
          items: list.items.values(),
          patientName: "Biscuit",
          basedOn: sent,
          finding: FINDING,
          photo: null,
        }),
      ),
    });
    expect(event!.modelOutput).toMatchObject({ answer: null, failure: { reason: "transport" } });
  });
});

describe("what is refused before the model is asked", () => {
  it("refuses a case with no sent estimate", async () => {
    const [kase] = await db
      .insert(patientCase)
      .values({ practiceId, patientName: "Rex", ownerName: "A. Owner", procedure: "Spay" })
      .returning();
    const counted = countingModel(createRecordedModel(store));

    const error = await draftUpdate(
      { db, model: counted.model },
      { practiceId, caseId: kase!.id, finding: FINDING, photo: null },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EstimateError);
    expect((error as EstimateError).reason).toBe("version_not_found");
    expect(counted.calls).toEqual([]);
  });

  it("redrafts an open update draft rather than making another version", async () => {
    const open = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: linesOf(sent),
    });
    answerWith({ lines: DELTA, explanation: EXPLANATION });

    const update = await draftUpdate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, finding: FINDING, photo: null },
    );

    expect(update.version.id).toBe(open.id);
    expect(update.version.lines).toHaveLength(5);
  });

  it.each([
    ["an empty finding", { finding: " ", photo: null }],
    [
      "a photo of another type",
      { finding: FINDING, photo: { mediaType: "image/tiff", dataBase64: "AA==" } },
    ],
    [
      "a photo that is not base64",
      { finding: FINDING, photo: { mediaType: "image/png", dataBase64: "not base64!" } },
    ],
  ])("refuses %s", async (_case, fields) => {
    const error = await draftUpdate(
      { db, model: createRecordedModel(store) },
      { practiceId, caseId, ...(fields as { finding: string; photo: null }) },
    ).catch((caught: unknown) => caught);
    expect((error as EstimateError).reason).toBe("request_invalid");
  });
});
