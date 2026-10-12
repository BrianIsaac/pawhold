import OpenAI from "openai";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";

import {
  type DraftModel,
  MODEL_SETTINGS,
  type ModelAnswer,
  ModelError,
  type ModelRequest,
} from "./model";

/** What the live client needs: the key, and for tests a fetch and a retry count. */
export interface OpenAIModelOptions {
  /** `OPENAI_API_KEY`, read on the server only. */
  readonly apiKey: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly maxRetries?: number;
  /** Milliseconds before a call is given up. */
  readonly timeout?: number;
}

/**
 * The Responses API request for a model request: the prompt and price list
 * in a developer message with an explicit cache breakpoint after them, then
 * the vet's words and photo, answered under the strict schema. Nothing is
 * stored at OpenAI (`store: false`).
 *
 * @param request - The request.
 * @returns The request body.
 */
export function responsesBody(request: ModelRequest): ResponseCreateParamsNonStreaming {
  const user: ResponseInputItem.Message["content"] = [{ type: "input_text", text: request.input }];
  if (request.image) {
    user.push({
      type: "input_image",
      image_url: `data:${request.image.mediaType};base64,${request.image.dataBase64}`,
      detail: "auto",
    });
  }
  return {
    model: MODEL_SETTINGS.model,
    reasoning: { effort: MODEL_SETTINGS.reasoningEffort },
    max_output_tokens: MODEL_SETTINGS.maxOutputTokens,
    store: false,
    prompt_cache_options: { mode: "explicit" },
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: request.instructions,
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
      { role: "user", content: user },
    ],
    text: {
      format: {
        type: request.format.type,
        name: request.format.name,
        strict: request.format.strict,
        schema: request.format.schema,
      },
    },
  };
}

/**
 * The live model: OpenAI's Responses API through the OpenAI SDK, server-side
 * only. A refusal, an answer cut short, a provider error or a network failure
 * is a {@link ModelError}, which leaves the vet an empty estimate.
 *
 * @param options - The key and transport options.
 * @returns The model.
 */
export function createOpenAIModel(options: OpenAIModelOptions): DraftModel {
  const client = new OpenAI({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? 1,
    timeout: options.timeout ?? 120_000,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    settings: MODEL_SETTINGS,
    answer: async (request): Promise<ModelAnswer> => {
      let response: OpenAI.Responses.Response;
      try {
        response = await client.responses.create(responsesBody(request));
      } catch (error) {
        throw asModelError(error);
      }
      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason ?? "unknown";
        throw new ModelError("truncated", `the answer was cut short (${reason})`);
      }
      const parts = response.output.flatMap((item) =>
        item.type === "message" ? item.content : [],
      );
      const refusal = parts.find((part) => part.type === "refusal");
      if (refusal) {
        throw new ModelError("refused", `the model refused: ${refusal.refusal}`);
      }
      const text = parts
        .flatMap((part) => (part.type === "output_text" ? [part.text] : []))
        .join("");
      if (text === "") {
        throw new ModelError("malformed", "the answer carried no text");
      }
      return { text, servedModel: response.model };
    },
  };
}

/**
 * A thrown SDK error as a model error, keeping the status and OpenAI's
 * request id and never the key.
 *
 * @param error - What the SDK threw.
 * @returns The model error.
 */
function asModelError(error: unknown): ModelError {
  if (error instanceof OpenAI.APIConnectionError) {
    return new ModelError("transport", `OpenAI could not be reached: ${error.message}`);
  }
  if (error instanceof OpenAI.APIError) {
    const request = error.requestID ? ` (request ${error.requestID})` : "";
    return new ModelError(
      "provider",
      `OpenAI answered ${error.status ?? "with an error"}${request}`,
      error.status ?? null,
    );
  }
  return new ModelError("transport", error instanceof Error ? error.message : String(error));
}
