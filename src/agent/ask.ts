import { z } from "zod";

import {
  type DraftModel,
  ModelError,
  type ModelFailure,
  type ModelRequest,
  requestHash,
} from "./model";

/** A model failure as a job reports it to the vet's screen and the audit trail. */
export interface AskFailure {
  readonly reason: ModelFailure;
  readonly message: string;
}

/** What one ask of the model came to. */
export type Asked<T> =
  | {
      readonly hash: string;
      readonly answer: T;
      readonly servedModel: string;
      readonly failure: null;
    }
  | {
      readonly hash: string;
      readonly answer: null;
      readonly servedModel: string | null;
      readonly failure: AskFailure;
    };

/**
 * Asks the model and reads its answer as JSON in the job's envelope. Any
 * failure, the model's or the answer's, is returned rather than thrown: the
 * caller leaves the vet an empty estimate and audits why.
 *
 * @param model - The model.
 * @param request - The request.
 * @param envelope - The answer's outer shape; lines inside it are checked one by one later.
 * @returns The answer, or why there is none.
 */
export async function askModel<T>(
  model: DraftModel,
  request: ModelRequest,
  envelope: z.ZodType<T>,
): Promise<Asked<T>> {
  const hash = requestHash(model.settings, request);
  let text: string;
  let servedModel: string;
  try {
    ({ text, servedModel } = await model.answer(request));
  } catch (error) {
    if (error instanceof ModelError) {
      return {
        hash,
        answer: null,
        servedModel: null,
        failure: { reason: error.reason, message: error.message },
      };
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      hash,
      answer: null,
      servedModel,
      failure: { reason: "malformed", message: "the answer was not JSON" },
    };
  }
  const parsed = envelope.safeParse(json);
  if (!parsed.success) {
    return {
      hash,
      answer: null,
      servedModel,
      failure: {
        reason: "malformed",
        message: `the answer did not follow the schema: ${z.prettifyError(parsed.error)}`,
      },
    };
  }
  return { hash, answer: parsed.data, servedModel, failure: null };
}

/**
 * A value as plain JSON, for the audit trail: optional fields left out
 * rather than written as undefined.
 *
 * @param value - The value.
 * @returns Its JSON copy.
 */
export function asJson(value: unknown): z.core.util.JSONType {
  return JSON.parse(JSON.stringify(value)) as z.core.util.JSONType;
}
