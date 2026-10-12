import { describe, expect, it } from "vitest";

import { draftRequest } from "@/agent/draft";
import { MODEL_SETTINGS, ModelError, requestHash } from "@/agent/model";
import { createRecordedModel, fileRecordedStore, memoryRecordedStore } from "@/agent/recorded";

import { gradeSet, loadNoteSets, runEval, SEED_ITEMS, type NoteSet } from "../../evals/grade";
import { primeAnswer } from "../support/agent";

const SETS = loadNoteSets();
const PLAN_EXAMPLE = SETS.find((set) => set.id === "01-dental-plan-example")!;

/**
 * A drafted line for the plan's example notes.
 *
 * @param code - The code.
 * @param notesSpan - The span.
 * @param ownerWording - The owner's wording.
 * @returns The line.
 */
function line(code: string, notesSpan: string, ownerWording = "Plain words") {
  return { code, quantityLow: 1, quantityHigh: 1, dependsOn: null, notesSpan, ownerWording };
}

const PERFECT = {
  lines: [
    line("GA-DENT", "GA"),
    line("DEN-SP", "dental scale and polish"),
    line("DEN-EXT-SG", "probable two extractions upper PM"),
    line("LAB-PRE", "pre-op bloods"),
  ],
  unmatched: [],
};

describe("the note sets", () => {
  it("are about thirty, each with a unique id matching its file", () => {
    expect(SETS).toHaveLength(30);
    expect(new Set(SETS.map((set) => set.id)).size).toBe(30);
  });

  it("expect and accept only codes on the seed's price list", () => {
    for (const set of SETS) {
      const codes = [...set.expected.flat(), ...set.acceptable];
      for (const code of codes) {
        expect(SEED_ITEMS.has(code), `${set.id}: ${code}`).toBe(true);
      }
    }
  });

  it("name unmatched phrases that are in their own notes", () => {
    for (const set of SETS) {
      for (const phrase of set.unmatched) {
        expect(set.notes, set.id).toContain(phrase);
      }
    }
  });
});

describe("grading one set", () => {
  it("scores the plan's example drafted as a vet would at full recall and precision", () => {
    const graded = gradeSet(PLAN_EXAMPLE, { answer: PERFECT, failure: null });
    expect(graded).toMatchObject({
      inventedCodes: [],
      inventedSpans: [],
      expectedFound: 4,
      expectedTotal: 4,
      keptCorrect: 4,
      keptTotal: 4,
      wordingFallbacks: 0,
    });
  });

  it("counts an alternative code as finding the expected item", () => {
    const answer = {
      ...PERFECT,
      lines: PERFECT.lines.map((drafted) =>
        drafted.code === "DEN-EXT-SG" ? { ...drafted, code: "DEN-EXT-S" } : drafted,
      ),
    };
    expect(gradeSet(PLAN_EXAMPLE, { answer, failure: null }).expectedFound).toBe(4);
  });

  it("breaks the hard bar on an invented code", () => {
    const answer = { ...PERFECT, lines: [...PERFECT.lines, line("DEN-EXT-PM", "upper PM")] };
    expect(gradeSet(PLAN_EXAMPLE, { answer, failure: null }).inventedCodes).toEqual(["DEN-EXT-PM"]);
  });

  it("breaks the hard bar on an invented span, in a line or in unmatched", () => {
    const answer = {
      lines: [...PERFECT.lines, line("IMG-XR-DENT", "dental x-rays")],
      unmatched: [{ notesSpan: "full mouth charting" }],
    };
    expect(gradeSet(PLAN_EXAMPLE, { answer, failure: null }).inventedSpans).toEqual([
      "dental x-rays",
      "full mouth charting",
    ]);
  });

  it("counts a code neither expected nor acceptable against precision", () => {
    const answer = { ...PERFECT, lines: [...PERFECT.lines, line("SURG-FB", "GA")] };
    const graded = gradeSet(PLAN_EXAMPLE, { answer, failure: null });
    expect(graded.keptCorrect).toBe(4);
    expect(graded.keptTotal).toBe(5);
    expect(graded.wrongCodes).toEqual(["SURG-FB"]);
  });

  it("counts an acceptable code as correct but not as found", () => {
    const answer = { ...PERFECT, lines: [...PERFECT.lines, line("DEN-CHART", "dental")] };
    const graded = gradeSet(PLAN_EXAMPLE, { answer, failure: null });
    expect(graded.keptCorrect).toBe(5);
    expect(graded.expectedFound).toBe(4);
  });

  it("counts owner's wording that fell back for money or a dose", () => {
    const answer = {
      ...PERFECT,
      lines: [line("LAB-PRE", "pre-op bloods", "Blood test, £72"), ...PERFECT.lines.slice(0, 3)],
    };
    expect(gradeSet(PLAN_EXAMPLE, { answer, failure: null }).wordingFallbacks).toBe(1);
  });

  it("finds nothing for a set the model failed on", () => {
    const graded = gradeSet(PLAN_EXAMPLE, {
      answer: null,
      failure: { reason: "refused", message: "refused" },
    });
    expect(graded).toMatchObject({ expectedFound: 0, expectedTotal: 4, keptTotal: 0 });
  });

  it("reports which unmatched phrases the model named", () => {
    const set: NoteSet = SETS.find((each) => each.id === "22-chocolate-ingestion")!;
    const graded = gradeSet(set, {
      answer: {
        lines: [line("HOSP-DAY", "monitor in day ward"), line("IMG-ECG", "ECG")],
        unmatched: [{ notesSpan: "Induce emesis" }],
      },
      failure: null,
    });
    expect(graded.unmatchedNamed).toEqual(["Induce emesis"]);
    expect(graded.unmatchedTotal).toBe(2);
  });
});

describe("running the eval", () => {
  it("grades every set over the double and sums recall and precision", async () => {
    const store = memoryRecordedStore();
    primeAnswer(store, draftRequest(SEED_ITEMS.values(), PLAN_EXAMPLE.notes), PERFECT);

    const result = await runEval([PLAN_EXAMPLE], createRecordedModel(store), {
      now: () => new Date("2026-10-12T15:00:00Z"),
    });

    expect(result).toMatchObject({
      date: "2026-10-12T15:00:00.000Z",
      model: "gpt-6.1-sol",
      sets: 1,
      answered: 1,
      notRecorded: [],
      hardBar: { met: true, complete: true, inventedCodes: 0, inventedSpans: 0 },
      recall: 1,
      precision: 1,
    });
  });

  it("names the sets with no recording and does not grade them", async () => {
    const result = await runEval([PLAN_EXAMPLE], createRecordedModel(memoryRecordedStore()));
    expect(result.notRecorded).toEqual(["01-dental-plan-example"]);
    expect(result.answered).toBe(0);
    expect(result.hardBar).toMatchObject({ met: false, complete: false, inventedCodes: 0 });
  });

  it("does not meet the hard bar when one set invents a code", async () => {
    const store = memoryRecordedStore();
    primeAnswer(store, draftRequest(SEED_ITEMS.values(), PLAN_EXAMPLE.notes), {
      ...PERFECT,
      lines: [...PERFECT.lines, line("FREE-ITEM", "GA")],
    });
    const result = await runEval([PLAN_EXAMPLE], createRecordedModel(store));
    expect(result.hardBar).toMatchObject({ met: false, inventedCodes: 1 });
  });

  it("reports a model failure on a set without hiding it", async () => {
    const model = {
      settings: MODEL_SETTINGS,
      answer: async () => {
        throw new ModelError("refused", "refused");
      },
    };
    const result = await runEval([PLAN_EXAMPLE], model);
    expect(result.failures).toEqual([{ set: "01-dental-plan-example", reason: "refused" }]);
    expect(result.hardBar).toMatchObject({ met: false, complete: false });
  });
});

describe("the recorded eval, as CI runs it", () => {
  // The answers in evals/recorded/ are gpt-6.1-sol's own, recorded live on
  // 12 October 2026 (`pnpm eval --live`); this replays them.
  it("has a recorded answer for every set and meets the hard bar", async () => {
    const store = fileRecordedStore(new URL("../../evals/recorded/", import.meta.url).pathname);
    for (const set of SETS) {
      const hash = requestHash(MODEL_SETTINGS, draftRequest(SEED_ITEMS.values(), set.notes));
      expect(store.get(hash), set.id).toBeDefined();
    }
    const result = await runEval(SETS, createRecordedModel(store));
    expect(result.notRecorded).toEqual([]);
    expect(result.hardBar.met).toBe(true);
  });
});
