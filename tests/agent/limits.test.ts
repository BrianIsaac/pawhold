import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { draftEstimate, draftRequest } from "@/agent/draft";
import { agentEnvironment, DEFAULT_DRAFTS_PER_HOUR, modelCallsInLastHour } from "@/agent/limits";
import { MODEL_SETTINGS, requestHash } from "@/agent/model";
import { createRecordedModel, memoryRecordedStore, type RecordedStore } from "@/agent/recorded";
import { agentAnswer, auditEvent, patientCase, practice } from "@/db/schema";
import { readEnvironment } from "@/env";
import { currentPriceList, importPriceList, type PriceListWithItems } from "@/estimate/price-list";

import { readSeedPriceList } from "../../seed/practice";
import { countingModel, primeAnswer } from "../support/agent";
import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();

const NOTES_A = "Bella, 8 kg cat. Spay. Pre-op bloods.";
const NOTES_B = "Bella, 8 kg cat. Spay, buster collar after.";

const ANSWER_A = {
  lines: [
    {
      code: "NEU-CAT-F",
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: null,
      notesSpan: "Spay",
      ownerWording: "Spaying Bella",
    },
  ],
  unmatched: [],
};

const ANSWER_B = {
  lines: [
    ...ANSWER_A.lines,
    {
      code: "CONS-COLLAR",
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: null,
      notesSpan: "buster collar",
      ownerWording: "A protective collar",
    },
  ],
  unmatched: [],
};

let practiceId: string;
let caseId: string;
let list: PriceListWithItems;
let store: RecordedStore;

/**
 * A practice with the seed list and one case.
 *
 * @returns The practice's id and its case's id.
 */
async function makePractice(): Promise<{ practiceId: string; caseId: string }> {
  const [made] = await db.insert(practice).values({ name: "Limits", kind: "judge" }).returning();
  await importPriceList(db, {
    practiceId: made!.id,
    actor: "system",
    sourceName: "seed/practice/price-list.csv",
    csv: readSeedPriceList(),
  });
  const [kase] = await db
    .insert(patientCase)
    .values({ practiceId: made!.id, patientName: "Bella", ownerName: "Jo", procedure: "Spay" })
    .returning();
  return { practiceId: made!.id, caseId: kase!.id };
}

beforeEach(async () => {
  ({ practiceId, caseId } = await makePractice());
  list = (await currentPriceList(db, practiceId))!;
  store = memoryRecordedStore();
  primeAnswer(store, draftRequest(list.items.values(), NOTES_A), ANSWER_A);
  primeAnswer(store, draftRequest(list.items.values(), NOTES_B), ANSWER_B);
});

/**
 * The case's `estimate.drafted` events, oldest first.
 *
 * @returns The events.
 */
async function draftedEvents() {
  return db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.drafted")))
    .orderBy(asc(auditEvent.id));
}

describe("drafting again while the draft is open", () => {
  it("redrafts the open draft's lines rather than making another version", async () => {
    const model = createRecordedModel(store);
    const first = await draftEstimate({ db, model }, { practiceId, caseId, notes: NOTES_A });
    const second = await draftEstimate({ db, model }, { practiceId, caseId, notes: NOTES_B });

    expect(second.version.id).toBe(first.version.id);
    expect(second.version.number).toBe(1);
    expect(second.version.lines.map((line) => line.code)).toEqual(["NEU-CAT-F", "CONS-COLLAR"]);
  });
});

describe("the draft cache (D8)", () => {
  it("answers the same notes and list a second time without asking the model", async () => {
    const counted = countingModel(createRecordedModel(store));

    const first = await draftEstimate(
      { db, model: counted.model },
      { practiceId, caseId, notes: NOTES_A },
    );
    const second = await draftEstimate(
      { db, model: counted.model },
      { practiceId, caseId, notes: NOTES_A },
    );

    expect(counted.calls).toHaveLength(1);
    expect(second.version.lines.map((line) => line.code)).toEqual(
      first.version.lines.map((line) => line.code),
    );
    expect(second.model).toEqual(first.model);
  });

  it("is keyed on the input's hash: other notes ask the model", async () => {
    const counted = countingModel(createRecordedModel(store));
    await draftEstimate({ db, model: counted.model }, { practiceId, caseId, notes: NOTES_A });
    await draftEstimate({ db, model: counted.model }, { practiceId, caseId, notes: NOTES_B });
    expect(counted.calls).toHaveLength(2);
  });

  it("is the practice's own: another practice's identical notes ask the model", async () => {
    const counted = countingModel(createRecordedModel(store));
    await draftEstimate({ db, model: counted.model }, { practiceId, caseId, notes: NOTES_A });
    const other = await makePractice();
    await draftEstimate(
      { db, model: counted.model },
      { practiceId: other.practiceId, caseId: other.caseId, notes: NOTES_A },
    );
    expect(counted.calls).toHaveLength(2);
  });

  it("keeps no failed answer: the next press asks the model again", async () => {
    const empty = memoryRecordedStore();
    const counted = countingModel(createRecordedModel(empty));
    const failed = await draftEstimate(
      { db, model: counted.model },
      { practiceId, caseId, notes: NOTES_A },
    );
    expect(failed.failure?.reason).toBe("not_recorded");
    const rows = await db.select().from(agentAnswer).where(eq(agentAnswer.practiceId, practiceId));
    expect(rows).toEqual([]);

    await draftEstimate({ db, model: counted.model }, { practiceId, caseId, notes: NOTES_A });
    expect(counted.calls).toHaveLength(2);
  });

  it("audits a cached answer with the same model id and input hash, marked as cached", async () => {
    const model = createRecordedModel(store);
    await draftEstimate({ db, model }, { practiceId, caseId, notes: NOTES_A });
    await draftEstimate({ db, model }, { practiceId, caseId, notes: NOTES_A });

    const [asked, cached] = await draftedEvents();
    expect(cached!.modelId).toBe("gpt-6.1-sol");
    expect(cached!.modelInputSha256).toBe(asked!.modelInputSha256);
    expect(asked!.detail).toMatchObject({ source: "model" });
    expect(cached!.detail).toMatchObject({ source: "cache" });
  });
});

describe("the per-session draft cap (D8)", () => {
  it("defaults to the plan's 40 an hour", () => {
    expect(DEFAULT_DRAFTS_PER_HOUR).toBe(40);
    expect(readEnvironment(agentEnvironment, {})).toEqual({ AGENT_DRAFTS_PER_HOUR: 40 });
  });

  it("reads a number, or off", () => {
    expect(readEnvironment(agentEnvironment, { AGENT_DRAFTS_PER_HOUR: "5" })).toEqual({
      AGENT_DRAFTS_PER_HOUR: 5,
    });
    expect(readEnvironment(agentEnvironment, { AGENT_DRAFTS_PER_HOUR: "off" })).toEqual({
      AGENT_DRAFTS_PER_HOUR: null,
    });
    for (const bad of ["0", "-1", "1.5", "many"]) {
      expect(() => readEnvironment(agentEnvironment, { AGENT_DRAFTS_PER_HOUR: bad })).toThrow(
        "AGENT_DRAFTS_PER_HOUR",
      );
    }
  });

  it("past the cap, does not ask the model and leaves an open draft as it was", async () => {
    const counted = countingModel(createRecordedModel(store));
    const limited = { db, model: counted.model, draftsPerHour: 1 };

    await draftEstimate(limited, { practiceId, caseId, notes: NOTES_A });
    const capped = await draftEstimate(limited, { practiceId, caseId, notes: NOTES_B });

    expect(counted.calls).toHaveLength(1);
    expect(capped.failure?.reason).toBe("capped");
    expect(capped.version.lines.map((line) => line.code)).toEqual(["NEU-CAT-F"]);
    const events = await draftedEvents();
    expect(events.map((event) => (event.detail as { source: string }).source)).toEqual([
      "model",
      "capped",
    ]);
    expect(events[1]!.modelInputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("past the cap, a first draft is an empty estimate the vet fills by hand", async () => {
    const limited = { db, model: createRecordedModel(store), draftsPerHour: 1 };
    await draftEstimate(limited, { practiceId, caseId, notes: NOTES_A });
    const [another] = await db
      .insert(patientCase)
      .values({ practiceId, patientName: "Milo", ownerName: "Jo", procedure: "Spay" })
      .returning();

    const capped = await draftEstimate(limited, {
      practiceId,
      caseId: another!.id,
      notes: NOTES_B,
    });

    expect(capped.failure?.reason).toBe("capped");
    expect(capped.version.lines).toEqual([]);
    expect(capped.version.number).toBe(1);
  });

  it("does not count a cached answer", async () => {
    const counted = countingModel(createRecordedModel(store));
    const limited = { db, model: counted.model, draftsPerHour: 2 };

    await draftEstimate(limited, { practiceId, caseId, notes: NOTES_A });
    await draftEstimate(limited, { practiceId, caseId, notes: NOTES_A });
    const third = await draftEstimate(limited, { practiceId, caseId, notes: NOTES_B });

    expect(third.failure).toBeNull();
    expect(await modelCallsInLastHour(db, practiceId)).toBe(2);
  });

  it("is the session's own: another practice is not capped", async () => {
    const counted = countingModel(createRecordedModel(store));
    await draftEstimate(
      { db, model: counted.model, draftsPerHour: 1 },
      { practiceId, caseId, notes: NOTES_A },
    );
    const other = await makePractice();
    const drafted = await draftEstimate(
      { db, model: counted.model, draftsPerHour: 1 },
      { practiceId: other.practiceId, caseId: other.caseId, notes: NOTES_A },
    );
    expect(drafted.failure).toBeNull();
  });

  it("forgets calls older than an hour", async () => {
    await db.insert(auditEvent).values({
      occurredAt: new Date(Date.now() - 61 * 60 * 1000),
      practiceId,
      caseId,
      actor: "system",
      action: "estimate.drafted",
      modelId: "gpt-6.1-sol",
      modelInputSha256: "a".repeat(64),
      modelOutput: {},
      detail: { source: "model" },
    });
    expect(await modelCallsInLastHour(db, practiceId)).toBe(0);
    const drafted = await draftEstimate(
      { db, model: createRecordedModel(store), draftsPerHour: 1 },
      { practiceId, caseId, notes: NOTES_A },
    );
    expect(drafted.failure).toBeNull();
  });

  it("is lifted by off", async () => {
    const model = createRecordedModel(store);
    await draftEstimate({ db, model, draftsPerHour: null }, { practiceId, caseId, notes: NOTES_A });
    const drafted = await draftEstimate(
      { db, model, draftsPerHour: null },
      { practiceId, caseId, notes: NOTES_B },
    );
    expect(drafted.failure).toBeNull();
  });
});

describe("a cached answer that no longer reads", () => {
  it("is replaced by the model's next answer", async () => {
    const hash = requestHash(MODEL_SETTINGS, draftRequest(list.items.values(), NOTES_A));
    await db.insert(agentAnswer).values({
      practiceId,
      inputSha256: hash,
      job: "draft",
      modelId: "gpt-6.1-sol",
      servedModel: "gpt-6.1-sol",
      answer: { lines: "stale" },
    });
    const counted = countingModel(createRecordedModel(store));

    await draftEstimate({ db, model: counted.model }, { practiceId, caseId, notes: NOTES_A });
    await draftEstimate({ db, model: counted.model }, { practiceId, caseId, notes: NOTES_A });

    expect(counted.calls).toHaveLength(1);
    const [row] = await db.select().from(agentAnswer).where(eq(agentAnswer.inputSha256, hash));
    expect(row!.answer).toEqual(ANSWER_A);
  });
});
