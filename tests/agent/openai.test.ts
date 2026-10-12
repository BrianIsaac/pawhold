import { describe, expect, it } from "vitest";

import { MODEL_SETTINGS, ModelError, type ModelRequest } from "@/agent/model";
import { createOpenAIModel } from "@/agent/openai";
import { DRAFT_FORMAT, UPDATE_FORMAT } from "@/agent/schema";
import { EnvironmentError, openaiEnvironment, readEnvironment } from "@/env";

const REQUEST: ModelRequest = {
  job: "draft",
  promptVersion: "draft.v1",
  instructions: "Draft an estimate.\n\nPrice list:\nLAB-PRE | Pre-anaesthetic blood screen",
  input: "pre-op bloods",
  image: null,
  format: DRAFT_FORMAT,
};

const ANSWER = '{"lines":[],"unmatched":[]}';

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/**
 * A Responses API answer as the API returns it, with one message.
 *
 * @param content - The message's content parts.
 * @param overrides - Fields to set on the response.
 * @returns The response body.
 */
function responseBody(
  content: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1_791_800_000,
    status: "completed",
    model: "gpt-6.1-sol-2026-09-30",
    output: [
      {
        id: "msg_test",
        type: "message",
        role: "assistant",
        status: "completed",
        content,
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

/**
 * A model over a fake fetch that answers each call in turn; no request leaves the process.
 *
 * @param replies - Each call's status and body, in order.
 * @returns The model and the requests it made.
 */
function fakeOpenAI(replies: { status: number; body: unknown }[]) {
  const calls: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const model = createOpenAIModel({ apiKey: "sk-test-not-a-key", fetch, maxRetries: 0 });
  return { model, calls };
}

describe("the OpenAI model client", () => {
  it("asks gpt-6.1-sol through the Responses API under the strict schema", async () => {
    const { model, calls } = fakeOpenAI([
      { status: 200, body: responseBody([{ type: "output_text", text: ANSWER, annotations: [] }]) },
    ]);

    await model.answer(REQUEST);

    const [call] = calls;
    expect(call!.url).toBe("https://api.openai.com/v1/responses");
    expect(call!.headers.get("authorization")).toBe("Bearer sk-test-not-a-key");
    expect(call!.body).toMatchObject({
      model: "gpt-6.1-sol",
      reasoning: { effort: "medium" },
      store: false,
      max_output_tokens: 16_000,
      text: {
        format: {
          type: "json_schema",
          name: "estimate_draft",
          strict: true,
          schema: DRAFT_FORMAT.schema,
        },
      },
    });
  });

  it("puts the instructions and price list first, cached, and the notes after them", async () => {
    const { model, calls } = fakeOpenAI([
      { status: 200, body: responseBody([{ type: "output_text", text: ANSWER, annotations: [] }]) },
    ]);

    await model.answer(REQUEST);

    expect(calls[0]!.body.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(calls[0]!.body.input).toEqual([
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: REQUEST.instructions,
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
      { role: "user", content: [{ type: "input_text", text: "pre-op bloods" }] },
    ]);
  });

  it("sends the update's photo after the vet's words, as a data URL", async () => {
    const { model, calls } = fakeOpenAI([
      { status: 200, body: responseBody([{ type: "output_text", text: ANSWER, annotations: [] }]) },
    ]);

    await model.answer({
      ...REQUEST,
      job: "update",
      promptVersion: "update.v1",
      format: UPDATE_FORMAT,
      image: { mediaType: "image/jpeg", dataBase64: "/9j/4AAQ" },
    });

    expect((calls[0]!.body.input as unknown[])[1]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "pre-op bloods" },
        { type: "input_image", image_url: "data:image/jpeg;base64,/9j/4AAQ", detail: "auto" },
      ],
    });
  });

  it("returns the answer's text and the model that served it", async () => {
    const { model } = fakeOpenAI([
      { status: 200, body: responseBody([{ type: "output_text", text: ANSWER, annotations: [] }]) },
    ]);

    await expect(model.answer(REQUEST)).resolves.toEqual({
      text: ANSWER,
      servedModel: "gpt-6.1-sol-2026-09-30",
    });
    expect(model.settings).toBe(MODEL_SETTINGS);
  });

  it.each([
    [
      "a refusal",
      responseBody([{ type: "refusal", refusal: "I can't help with that." }]),
      "refused",
    ],
    [
      "an answer cut off at the token limit",
      responseBody([{ type: "output_text", text: '{"lines":[', annotations: [] }], {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
      "truncated",
    ],
    ["an answer with no text", responseBody([]), "malformed"],
  ])("reports %s as a model error", async (_case, body, reason) => {
    const { model } = fakeOpenAI([{ status: 200, body }]);
    const error = await model.answer(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).reason).toBe(reason);
  });

  it("reports the provider's error with its status and request id, never the key", async () => {
    const { model } = fakeOpenAI([
      {
        status: 401,
        body: { error: { message: "Incorrect API key provided", type: "invalid_request_error" } },
      },
    ]);
    const error = (await model.answer(REQUEST).catch((caught: unknown) => caught)) as ModelError;
    expect(error).toBeInstanceOf(ModelError);
    expect(error.reason).toBe("provider");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain("sk-test-not-a-key");
  });

  it("reports a network failure as a transport error", async () => {
    const fetch = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    const model = createOpenAIModel({ apiKey: "sk-test-not-a-key", fetch, maxRetries: 0 });
    const error = (await model.answer(REQUEST).catch((caught: unknown) => caught)) as ModelError;
    expect(error).toBeInstanceOf(ModelError);
    expect(error.reason).toBe("transport");
  });
});

describe("the OpenAI key in the environment", () => {
  it("is read from OPENAI_API_KEY", () => {
    expect(readEnvironment(openaiEnvironment, { OPENAI_API_KEY: "sk-test" })).toEqual({
      OPENAI_API_KEY: "sk-test",
    });
  });

  it("names the variable, never a value, when it is missing", () => {
    expect(() => readEnvironment(openaiEnvironment, {})).toThrow(EnvironmentError);
    expect(() => readEnvironment(openaiEnvironment, { OPENAI_API_KEY: "" })).toThrow(
      "missing or malformed environment: OPENAI_API_KEY",
    );
  });
});
