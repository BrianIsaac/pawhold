import {
  type DraftModel,
  MODEL_SETTINGS,
  ModelError,
  type ModelRequest,
  requestHash,
} from "../../src/agent/model";
import { type RecordedStore } from "../../src/agent/recorded";

/**
 * Records an answer for a request in a store, as the live run would have.
 *
 * @param store - The store.
 * @param request - The request the answer is for.
 * @param answer - The answer: a value written as JSON, or raw text.
 * @returns The request's hash.
 */
export function primeAnswer(store: RecordedStore, request: ModelRequest, answer: unknown): string {
  const hash = requestHash(MODEL_SETTINGS, request);
  store.put({
    hash,
    job: request.job,
    promptVersion: request.promptVersion,
    model: MODEL_SETTINGS.model,
    reasoningEffort: MODEL_SETTINGS.reasoningEffort,
    servedModel: MODEL_SETTINGS.model,
    text: typeof answer === "string" ? answer : JSON.stringify(answer),
    recordedAt: "2026-10-12T12:00:00.000Z",
  });
  return hash;
}

/**
 * A model wrapper that counts the requests that reach it.
 *
 * @param inner - The model.
 * @returns The wrapper and its count.
 */
export function countingModel(inner: DraftModel): { model: DraftModel; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    model: {
      settings: inner.settings,
      answer: (request) => {
        calls.push(request);
        return inner.answer(request);
      },
    },
  };
}

/**
 * A model that always fails with the given reason.
 *
 * @param reason - Why.
 * @returns The model.
 */
export function failingModel(reason: ModelError["reason"]): DraftModel {
  return {
    settings: MODEL_SETTINGS,
    answer: async () => {
      throw new ModelError(reason, `the model failed: ${reason}`);
    },
  };
}
