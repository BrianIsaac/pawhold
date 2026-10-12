import { createHash } from "node:crypto";

/**
 * The model every job of the agent asks, and how (D7 as the operator
 * overruled it on 12 October: OpenAI, `gpt-6.1-sol`). The settings are part
 * of every request's hash, so a recorded answer is only ever replayed for the
 * model and effort that gave it.
 */
export const MODEL_SETTINGS = {
  provider: "openai",
  model: "gpt-6.1-sol",
  reasoningEffort: "medium",
  maxOutputTokens: 16_000,
} as const satisfies ModelSettings;

/** Which model a request goes to, and how hard it reasons. */
export interface ModelSettings {
  readonly provider: "openai";
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly maxOutputTokens: number;
}

/** The agent's jobs that ask a model (plan 3.4, jobs 1 and 2). */
export type AgentJob = "draft" | "update";

/** A JSON Schema, as plain JSON. */
export type JsonSchema = Record<string, unknown>;

/** The structured-output format a request is answered in. */
export interface StructuredFormat {
  readonly type: "json_schema";
  readonly name: string;
  readonly strict: true;
  readonly schema: JsonSchema;
}

/** An image sent with a request: the update's photo. */
export interface ModelImage {
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** The image's bytes, base64. */
  readonly dataBase64: string;
}

/**
 * One request to the model, in no provider's shape: the stable instructions
 * (the prompt and the price list, cached), the varying input (the vet's
 * words), an optional photo, and the schema the answer must follow.
 */
export interface ModelRequest {
  readonly job: AgentJob;
  /** The prompt's version, as `draft.v1`. */
  readonly promptVersion: string;
  /** The prompt and the price list; the same for every request of a practice. */
  readonly instructions: string;
  /** The vet's notes or finding. */
  readonly input: string;
  readonly image: ModelImage | null;
  readonly format: StructuredFormat;
}

/** What the model answered: the JSON text and the model that served it. */
export interface ModelAnswer {
  readonly text: string;
  /** The model as the provider names it in the answer (may be a dated snapshot). */
  readonly servedModel: string;
}

/**
 * The one seam every job asks a model through. The live client, the
 * recorded-answer double, the recorder and the draft cache all implement it.
 */
export interface DraftModel {
  readonly settings: ModelSettings;
  /**
   * @param request - The request.
   * @returns The answer.
   * @throws ModelError when there is no usable answer.
   */
  answer(request: ModelRequest): Promise<ModelAnswer>;
}

/** Why a model gave no usable answer. */
export type ModelFailure =
  | "unavailable"
  | "not_recorded"
  | "refused"
  | "truncated"
  | "malformed"
  | "provider"
  | "transport"
  | "capped";

/** A model call that gave no usable answer; the vet fills the estimate by hand. */
export class ModelError extends Error {
  override readonly name = "ModelError";

  /**
   * @param reason - Why, as a stable word a caller can branch on.
   * @param message - Why, in words; never a credential.
   * @param status - The provider's HTTP status, when it answered with one.
   */
  constructor(
    readonly reason: ModelFailure,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/**
 * JSON with every object's keys sorted, at every depth, so equal values
 * always write the same text.
 *
 * @param value - A JSON value.
 * @returns Its canonical text.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The SHA-256 of a request and the settings it is sent with. It keys the
 * recorded answers, the draft cache and the audit trail's input hash.
 *
 * @param settings - The model and effort.
 * @param request - The request.
 * @returns The hash, lower-case hex.
 */
export function requestHash(settings: ModelSettings, request: ModelRequest): string {
  return createHash("sha256").update(canonicalJson({ settings, request })).digest("hex");
}
