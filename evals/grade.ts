import { readdirSync, readFileSync } from "node:fs";

import { z } from "zod";

import { draftRequest } from "../src/agent/draft";
import { findSpan, guardLines } from "../src/agent/guardrails";
import { type DraftModel, ModelError, type ModelFailure } from "../src/agent/model";
import { type PriceListEntry, parsePriceList, priceListCode } from "../src/estimate/price-list";
import { readSeedPriceList } from "../seed/practice";

/**
 * The estimate agent's evaluation (plan 3.4, "Evaluation"; U4): about thirty
 * note sets written for the fictional practice, each with the codes a vet
 * would expect. The bar: no invented code and no invented span, ever, in any
 * set (a hard fail); code recall and precision reported; the owner's wording
 * checked for amounts and doses.
 */

/** The fictional practice's price list (D2), by code. */
export const SEED_ITEMS: ReadonlyMap<string, PriceListEntry> = new Map(
  parsePriceList(readSeedPriceList()).map((entry) => [entry.code, entry]),
);

const NOTES_DIRECTORY = new URL("./notes/", import.meta.url);

/** One note set: the notes, the codes expected, and the codes also acceptable. */
export const noteSet = z.strictObject({
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  title: z.string().min(1),
  notes: z.string().min(1),
  /** Each item a vet would expect; an inner list is alternatives, any one of which finds it. */
  expected: z.array(z.union([priceListCode, z.array(priceListCode).min(2)])),
  /** Codes a vet would accept without expecting them: they do not count against precision. */
  acceptable: z.array(priceListCode),
  /** Phrases of the notes no item on the list covers. */
  unmatched: z.array(z.string().min(1)),
});

export type NoteSet = z.output<typeof noteSet>;

/**
 * Reads every note set under `evals/notes/`, each named for its id.
 *
 * @returns The sets, in id order.
 */
export function loadNoteSets(): NoteSet[] {
  return readdirSync(NOTES_DIRECTORY)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const set = noteSet.parse(JSON.parse(readFileSync(new URL(name, NOTES_DIRECTORY), "utf8")));
      if (`${set.id}.json` !== name) {
        throw new Error(`the note set in ${name} has the id ${set.id}`);
      }
      return set;
    });
}

const draftEnvelope = z.strictObject({
  lines: z.array(z.unknown()),
  unmatched: z.array(z.unknown()),
});

/** A draft's answer for one set, or the failure in its place. */
export interface SetAnswer {
  readonly answer: {
    readonly lines: readonly unknown[];
    readonly unmatched: readonly unknown[];
  } | null;
  readonly failure: { readonly reason: ModelFailure; readonly message: string } | null;
}

/** One set graded. */
export interface GradedSet {
  readonly id: string;
  readonly failure: ModelFailure | null;
  /** Codes the model returned that are not on the list: the hard bar. */
  readonly inventedCodes: readonly string[];
  /** Spans the model quoted that are not in the notes: the hard bar. */
  readonly inventedSpans: readonly string[];
  /** Expected items the kept lines found. */
  readonly expectedFound: number;
  readonly expectedTotal: number;
  /** Distinct kept codes that are expected or acceptable. */
  readonly keptCorrect: number;
  readonly keptTotal: number;
  /** Kept codes neither expected nor acceptable. */
  readonly wrongCodes: readonly string[];
  /** Expected items no kept line found (the first code of each). */
  readonly missedCodes: readonly string[];
  /** Kept lines whose owner's wording fell back for money, a percentage or a dose. */
  readonly wordingFallbacks: number;
  /** The set's unmatched phrases an unmatched span covered. */
  readonly unmatchedNamed: readonly string[];
  readonly unmatchedTotal: number;
}

/**
 * Grades one set's answer. The hard bar is read from the answer as the model
 * gave it; recall and precision from the lines the guardrails keep, which is
 * what the vet sees.
 *
 * @param set - The note set.
 * @param given - The answer, or its failure.
 * @returns The grade.
 */
export function gradeSet(set: NoteSet, given: SetAnswer): GradedSet {
  const expectedTotal = set.expected.length;
  const lines = given.answer?.lines ?? [];
  const unmatched = given.answer?.unmatched ?? [];
  const fieldOf = (raw: unknown, field: string): string | null => {
    const value =
      typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[field] : null;
    return typeof value === "string" ? value : null;
  };

  const inventedCodes = lines
    .map((raw) => fieldOf(raw, "code"))
    .filter((code): code is string => code !== null && !SEED_ITEMS.has(code));
  const inventedSpans = [...lines, ...unmatched]
    .map((raw) => fieldOf(raw, "notesSpan"))
    .filter((span): span is string => span !== null && findSpan(set.notes, span) === null);

  const guarded = guardLines(lines, unmatched, set.notes, SEED_ITEMS);
  const kept = [...new Set(guarded.kept.map((each) => each.line.code))];
  const correct = new Set([...set.expected.flat(), ...set.acceptable]);
  const found = set.expected.filter((item) =>
    (Array.isArray(item) ? item : [item]).some((code) => kept.includes(code)),
  );
  const missed = set.expected.filter((item) => !found.includes(item));
  const unmatchedNamed = set.unmatched.filter((phrase) => {
    const at = set.notes.indexOf(phrase);
    return guarded.unmatched.some((span) => span.start < at + phrase.length && at < span.end);
  });

  return {
    id: set.id,
    failure: given.failure?.reason ?? null,
    inventedCodes,
    inventedSpans,
    expectedFound: found.length,
    expectedTotal,
    keptCorrect: kept.filter((code) => correct.has(code)).length,
    keptTotal: kept.length,
    wrongCodes: kept.filter((code) => !correct.has(code)),
    missedCodes: missed.map((item) => (Array.isArray(item) ? item.join(" or ") : item)),
    wordingFallbacks: guarded.kept.filter((each) => each.ownerWordingFellBack !== null).length,
    unmatchedNamed,
    unmatchedTotal: set.unmatched.length,
  };
}

/** An eval run's result. */
export interface EvalResult {
  readonly date: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly servedModels: readonly string[];
  readonly sets: number;
  readonly answered: number;
  readonly notRecorded: readonly string[];
  readonly failures: readonly { readonly set: string; readonly reason: ModelFailure }[];
  readonly hardBar: {
    /** No invented code or span, and every set answered: the bar is "across every set". */
    readonly met: boolean;
    /** Whether every set was answered, so the bar could be judged at all. */
    readonly complete: boolean;
    readonly inventedCodes: number;
    readonly inventedSpans: number;
  };
  readonly recall: number | null;
  readonly precision: number | null;
  readonly expectedFound: number;
  readonly expectedTotal: number;
  readonly keptCorrect: number;
  readonly keptTotal: number;
  readonly wordingFallbacks: number;
  readonly unmatchedNamed: number;
  readonly unmatchedTotal: number;
  readonly graded: readonly GradedSet[];
}

/** How an eval runs. */
export interface EvalOptions {
  /** The clock for the run's date. */
  readonly now?: () => Date;
  /** How many sets are asked at once. */
  readonly concurrency?: number;
}

/**
 * Runs the eval: drafts every set's notes against the fictional practice's
 * list through the given model (the recorded double in CI, the live model on
 * demand), grades each, and sums them. A set with no recorded answer is named
 * and left out; a set the model failed on counts as finding nothing.
 *
 * @param sets - The note sets.
 * @param model - The model.
 * @param options - The clock and the concurrency.
 * @returns The result.
 */
export async function runEval(
  sets: readonly NoteSet[],
  model: DraftModel,
  options: EvalOptions = {},
): Promise<EvalResult> {
  const date = (options.now ?? (() => new Date()))().toISOString();
  const servedModels = new Set<string>();
  const outcomes: (SetAnswer | "not_recorded")[] = new Array(sets.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sets.length) {
      const at = next++;
      outcomes[at] = await answerSet(model, sets[at]!, servedModels);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker));

  const graded: GradedSet[] = [];
  const notRecorded: string[] = [];
  sets.forEach((set, at) => {
    const outcome = outcomes[at]!;
    if (outcome === "not_recorded") {
      notRecorded.push(set.id);
    } else {
      graded.push(gradeSet(set, outcome));
    }
  });
  const sum = (field: keyof GradedSet): number =>
    graded.reduce((total, set) => total + (set[field] as number), 0);
  const inventedCodes = graded.reduce((total, set) => total + set.inventedCodes.length, 0);
  const inventedSpans = graded.reduce((total, set) => total + set.inventedSpans.length, 0);
  const complete = notRecorded.length === 0 && graded.every((set) => set.failure === null);
  const expectedTotal = sum("expectedTotal");
  const keptTotal = sum("keptTotal");
  return {
    date,
    model: model.settings.model,
    reasoningEffort: model.settings.reasoningEffort,
    servedModels: [...servedModels].sort(),
    sets: sets.length,
    answered: graded.filter((set) => set.failure === null).length,
    notRecorded,
    failures: graded.flatMap((set) => (set.failure ? [{ set: set.id, reason: set.failure }] : [])),
    hardBar: {
      met: inventedCodes === 0 && inventedSpans === 0 && complete,
      complete,
      inventedCodes,
      inventedSpans,
    },
    recall: expectedTotal === 0 ? null : sum("expectedFound") / expectedTotal,
    precision: keptTotal === 0 ? null : sum("keptCorrect") / keptTotal,
    expectedFound: sum("expectedFound"),
    expectedTotal,
    keptCorrect: sum("keptCorrect"),
    keptTotal,
    wordingFallbacks: sum("wordingFallbacks"),
    unmatchedNamed: graded.reduce((total, set) => total + set.unmatchedNamed.length, 0),
    unmatchedTotal: sum("unmatchedTotal"),
    graded,
  };
}

/**
 * Asks the model for one set's draft and reads the answer in the draft's envelope.
 *
 * @param model - The model.
 * @param set - The set.
 * @param servedModels - Where the serving model's name is collected.
 * @returns The answer, its failure, or that no answer is recorded.
 */
async function answerSet(
  model: DraftModel,
  set: NoteSet,
  servedModels: Set<string>,
): Promise<SetAnswer | "not_recorded"> {
  let text: string;
  try {
    const answered = await model.answer(draftRequest(SEED_ITEMS.values(), set.notes));
    servedModels.add(answered.servedModel);
    text = answered.text;
  } catch (error) {
    if (error instanceof ModelError) {
      return error.reason === "not_recorded"
        ? "not_recorded"
        : { answer: null, failure: { reason: error.reason, message: error.message } };
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { answer: null, failure: { reason: "malformed", message: "the answer was not JSON" } };
  }
  const parsed = draftEnvelope.safeParse(json);
  return parsed.success
    ? { answer: parsed.data, failure: null }
    : {
        answer: null,
        failure: { reason: "malformed", message: "the answer is outside the schema" },
      };
}
