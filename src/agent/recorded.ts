import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  type DraftModel,
  type ModelAnswer,
  ModelError,
  type ModelRequest,
  requestHash,
} from "./model";
import { MODEL_SETTINGS } from "./model";

const HASH = /^[0-9a-f]{64}$/;

/** One recorded answer: what a model answered to the request with this hash. */
export const recordedAnswer = z.strictObject({
  hash: z.string().regex(HASH),
  job: z.enum(["draft", "update"]),
  promptVersion: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  servedModel: z.string().min(1),
  text: z.string(),
  recordedAt: z.iso.datetime(),
});

export type RecordedAnswer = z.output<typeof recordedAnswer>;

/** A store of recorded answers by request hash. */
export interface RecordedStore {
  /**
   * @param hash - The request hash.
   * @returns The answer recorded under it, if any.
   */
  get(hash: string): RecordedAnswer | undefined;
  /**
   * @param answer - The answer to keep under its hash.
   */
  put(answer: RecordedAnswer): void;
}

/**
 * Recorded answers held in memory, for tests.
 *
 * @returns The store.
 */
export function memoryRecordedStore(): RecordedStore {
  const answers = new Map<string, RecordedAnswer>();
  return {
    get: (hash) => answers.get(hash),
    put: (answer) => {
      answers.set(answer.hash, recordedAnswer.parse(answer));
    },
  };
}

/**
 * Recorded answers kept one JSON file per request hash in a directory
 * (`evals/recorded/` in the repository).
 *
 * @param directory - The directory.
 * @returns The store.
 */
export function fileRecordedStore(directory: string): RecordedStore {
  const pathOf = (hash: string): string => {
    if (!HASH.test(hash)) {
      throw new Error(`${JSON.stringify(hash)} is not a request hash`);
    }
    return join(directory, `${hash}.json`);
  };
  return {
    get: (hash) => {
      const path = pathOf(hash);
      if (!existsSync(path)) {
        return undefined;
      }
      const answer = recordedAnswer.parse(JSON.parse(readFileSync(path, "utf8")));
      if (answer.hash !== hash) {
        throw new Error(`the recording at ${path} names hash ${answer.hash}, which does not match`);
      }
      return answer;
    },
    put: (answer) => {
      const parsed = recordedAnswer.parse(answer);
      mkdirSync(directory, { recursive: true });
      writeFileSync(pathOf(parsed.hash), `${JSON.stringify(parsed, null, 2)}\n`);
    },
  };
}

/**
 * The recorded-answer double: answers each request with the answer recorded
 * under its hash, for the model it stands in for. It never calls a provider.
 *
 * @param store - The recorded answers.
 * @returns The model.
 */
export function createRecordedModel(store: RecordedStore): DraftModel {
  return {
    settings: MODEL_SETTINGS,
    answer: async (request: ModelRequest): Promise<ModelAnswer> => {
      const hash = requestHash(MODEL_SETTINGS, request);
      const recorded = store.get(hash);
      if (!recorded) {
        throw new ModelError("not_recorded", `no answer is recorded for request ${hash}`);
      }
      return { text: recorded.text, servedModel: recorded.servedModel };
    },
  };
}

/**
 * A model that records every answer its inner model gives under the
 * request's hash. Failures are not recorded.
 *
 * @param inner - The model asked.
 * @param store - Where answers are kept.
 * @param now - The clock for `recordedAt`.
 * @returns The recording model.
 */
export function recordingModel(
  inner: DraftModel,
  store: RecordedStore,
  now: () => Date = () => new Date(),
): DraftModel {
  return {
    settings: inner.settings,
    answer: async (request) => {
      const answer = await inner.answer(request);
      store.put({
        hash: requestHash(inner.settings, request),
        job: request.job,
        promptVersion: request.promptVersion,
        model: inner.settings.model,
        reasoningEffort: inner.settings.reasoningEffort,
        servedModel: answer.servedModel,
        text: answer.text,
        recordedAt: now().toISOString(),
      });
      return answer;
    },
  };
}

/**
 * The recorded answer when there is one, else the live model's, recorded:
 * a live eval asks the provider once per request, however often it is run.
 *
 * @param store - The recorded answers.
 * @param live - The live model.
 * @param now - The clock for `recordedAt`.
 * @returns The model.
 */
export function recordedThenLive(
  store: RecordedStore,
  live: DraftModel,
  now: () => Date = () => new Date(),
): DraftModel {
  const recorded = createRecordedModel(store);
  const recording = recordingModel(live, store, now);
  return {
    settings: live.settings,
    answer: async (request) => {
      try {
        return await recorded.answer(request);
      } catch (error) {
        if (error instanceof ModelError && error.reason === "not_recorded") {
          return recording.answer(request);
        }
        throw error;
      }
    },
  };
}
