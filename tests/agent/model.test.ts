import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  MODEL_SETTINGS,
  ModelError,
  type ModelRequest,
  requestHash,
} from "@/agent/model";
import {
  createRecordedModel,
  fileRecordedStore,
  memoryRecordedStore,
  recordingModel,
} from "@/agent/recorded";
import { DRAFT_FORMAT } from "@/agent/schema";

const REQUEST: ModelRequest = {
  job: "draft",
  promptVersion: "draft.v1",
  instructions:
    "Draft an estimate from the notes.\nCON-STD | Consultation | consultation | consultation",
  input: "GA, dental scale and polish, pre-op bloods",
  image: null,
  format: DRAFT_FORMAT,
};

const ANSWER = '{"lines":[],"unmatched":[]}';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A fresh directory under the system's temporary directory, removed after the test.
 *
 * @returns Its path.
 */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "pawhold-recorded-"));
  made.push(dir);
  return dir;
}

describe("the request hash", () => {
  it("is a lower-case SHA-256", () => {
    expect(requestHash(MODEL_SETTINGS, REQUEST)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the order keys were written in", () => {
    const reordered = {
      format: REQUEST.format,
      image: null,
      input: REQUEST.input,
      instructions: REQUEST.instructions,
      promptVersion: REQUEST.promptVersion,
      job: REQUEST.job,
    } satisfies ModelRequest;
    expect(requestHash(MODEL_SETTINGS, reordered)).toBe(requestHash(MODEL_SETTINGS, REQUEST));
  });

  it("changes with the notes, the prompt's version, the model and the effort", () => {
    const base = requestHash(MODEL_SETTINGS, REQUEST);
    expect(requestHash(MODEL_SETTINGS, { ...REQUEST, input: `${REQUEST.input}.` })).not.toBe(base);
    expect(requestHash(MODEL_SETTINGS, { ...REQUEST, promptVersion: "draft.v2" })).not.toBe(base);
    expect(requestHash({ ...MODEL_SETTINGS, model: "gpt-6-luna" }, REQUEST)).not.toBe(base);
    expect(requestHash({ ...MODEL_SETTINGS, reasoningEffort: "high" }, REQUEST)).not.toBe(base);
  });

  it("changes with the photo's bytes", () => {
    const withPhoto = (data: string): ModelRequest => ({
      ...REQUEST,
      job: "update",
      image: { mediaType: "image/png", dataBase64: data },
    });
    expect(requestHash(MODEL_SETTINGS, withPhoto("aGVsbG8="))).not.toBe(
      requestHash(MODEL_SETTINGS, withPhoto("aGVsbG9v")),
    );
  });

  it("writes canonical JSON with sorted keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"e":2,"f":1}]},"b":1}',
    );
  });
});

describe("the recorded-answer double", () => {
  it("names the model it stands in for", () => {
    expect(MODEL_SETTINGS).toEqual({
      provider: "openai",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
      maxOutputTokens: 16_000,
    });
    expect(createRecordedModel(memoryRecordedStore()).settings).toBe(MODEL_SETTINGS);
  });

  it("answers a request from the answer recorded under its hash", async () => {
    const store = memoryRecordedStore();
    store.put({
      hash: requestHash(MODEL_SETTINGS, REQUEST),
      job: "draft",
      promptVersion: "draft.v1",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
      servedModel: "gpt-6.1-sol",
      text: ANSWER,
      recordedAt: "2026-10-12T00:00:00.000Z",
    });

    await expect(createRecordedModel(store).answer(REQUEST)).resolves.toEqual({
      text: ANSWER,
      servedModel: "gpt-6.1-sol",
    });
  });

  it("refuses a request it has no recording for, as a model error", async () => {
    const error = await createRecordedModel(memoryRecordedStore())
      .answer(REQUEST)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).reason).toBe("not_recorded");
  });
});

describe("the recorded store on disk", () => {
  it("writes one file per hash and reads it back", () => {
    const dir = scratch();
    const store = fileRecordedStore(dir);
    const hash = requestHash(MODEL_SETTINGS, REQUEST);
    store.put({
      hash,
      job: "draft",
      promptVersion: "draft.v1",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
      servedModel: "gpt-6.1-sol-2026-09-30",
      text: ANSWER,
      recordedAt: "2026-10-12T00:00:00.000Z",
    });

    expect(readdirSync(dir)).toEqual([`${hash}.json`]);
    expect(JSON.parse(readFileSync(join(dir, `${hash}.json`), "utf8"))).toMatchObject({
      hash,
      servedModel: "gpt-6.1-sol-2026-09-30",
    });
    expect(fileRecordedStore(dir).get(hash)?.text).toBe(ANSWER);
  });

  it("has nothing for a hash never recorded", () => {
    expect(fileRecordedStore(scratch()).get("0".repeat(64))).toBeUndefined();
  });

  it("refuses a recording whose hash is not its file's name", () => {
    const dir = scratch();
    const hash = requestHash(MODEL_SETTINGS, REQUEST);
    writeFileSync(
      join(dir, `${hash}.json`),
      JSON.stringify({
        hash: "f".repeat(64),
        job: "draft",
        promptVersion: "draft.v1",
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
        servedModel: "gpt-6.1-sol",
        text: ANSWER,
        recordedAt: "2026-10-12T00:00:00.000Z",
      }),
    );
    expect(() => fileRecordedStore(dir).get(hash)).toThrow(/does not match/);
  });

  it("never reads outside its directory", () => {
    expect(() => fileRecordedStore(scratch()).get("../package")).toThrow(/not a request hash/);
  });
});

describe("recording a model's answers", () => {
  it("stores what the inner model answered under the request's hash", async () => {
    const store = memoryRecordedStore();
    const inner = {
      settings: MODEL_SETTINGS,
      answer: async () => ({ text: ANSWER, servedModel: "gpt-6.1-sol-2026-09-30" }),
    };
    const recording = recordingModel(inner, store, () => new Date("2026-10-12T09:30:00Z"));

    await expect(recording.answer(REQUEST)).resolves.toEqual({
      text: ANSWER,
      servedModel: "gpt-6.1-sol-2026-09-30",
    });
    expect(store.get(requestHash(MODEL_SETTINGS, REQUEST))).toEqual({
      hash: requestHash(MODEL_SETTINGS, REQUEST),
      job: "draft",
      promptVersion: "draft.v1",
      model: "gpt-6.1-sol",
      reasoningEffort: "medium",
      servedModel: "gpt-6.1-sol-2026-09-30",
      text: ANSWER,
      recordedAt: "2026-10-12T09:30:00.000Z",
    });
  });

  it("records nothing when the inner model fails", async () => {
    const store = memoryRecordedStore();
    const inner = {
      settings: MODEL_SETTINGS,
      answer: async () => {
        throw new ModelError("refused", "the model refused");
      },
    };
    await expect(recordingModel(inner, store).answer(REQUEST)).rejects.toThrow(ModelError);
    expect(store.get(requestHash(MODEL_SETTINGS, REQUEST))).toBeUndefined();
  });
});
