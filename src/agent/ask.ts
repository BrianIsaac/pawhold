import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Executor } from "@/db/client";
import { agentAnswer } from "@/db/schema";

import { modelCallsInLastHour } from "./limits";
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

/**
 * Where an answer came from: the model, the practice's draft cache, or
 * nowhere because the practice's hourly cap was reached.
 */
export type AnswerSource = "model" | "cache" | "capped";

/** What one ask came to. */
export type Asked<T> =
  | {
      readonly hash: string;
      readonly source: AnswerSource;
      readonly answer: T;
      readonly servedModel: string;
      readonly failure: null;
    }
  | {
      readonly hash: string;
      readonly source: AnswerSource;
      readonly answer: null;
      readonly servedModel: string | null;
      readonly failure: AskFailure;
    };

/** Who is asking, and under what limits. */
export interface AskContext {
  readonly db: Executor;
  readonly model: DraftModel;
  readonly practiceId: string;
  /** Model calls the practice may make in an hour; null for no cap. */
  readonly draftsPerHour: number | null;
}

/**
 * Asks for a job's answer (D8): from the practice's draft cache when the same
 * request was answered before; otherwise, unless the practice's hourly cap is
 * reached, from the model, keeping an answer that passed the envelope in the
 * cache. Every failure, the model's, the answer's or the cap's, is returned
 * rather than thrown: the caller leaves the vet an empty estimate and audits
 * why.
 *
 * @param context - The database, the model, the practice and its cap.
 * @param request - The request.
 * @param envelope - The answer's outer shape; lines inside it are checked one by one later.
 * @returns The answer and where it came from, or why there is none.
 */
export async function askModel<T>(
  context: AskContext,
  request: ModelRequest,
  envelope: z.ZodType<T>,
): Promise<Asked<T>> {
  const { db, model, practiceId, draftsPerHour } = context;
  const hash = requestHash(model.settings, request);

  const [cached] = await db
    .select({ answer: agentAnswer.answer, servedModel: agentAnswer.servedModel })
    .from(agentAnswer)
    .where(and(eq(agentAnswer.practiceId, practiceId), eq(agentAnswer.inputSha256, hash)));
  if (cached) {
    const parsed = envelope.safeParse(cached.answer);
    if (parsed.success) {
      return {
        hash,
        source: "cache",
        answer: parsed.data,
        servedModel: cached.servedModel,
        failure: null,
      };
    }
  }

  if (draftsPerHour !== null && (await modelCallsInLastHour(db, practiceId)) >= draftsPerHour) {
    return {
      hash,
      source: "capped",
      answer: null,
      servedModel: null,
      failure: {
        reason: "capped",
        message: `the practice has asked the model ${draftsPerHour} times in the last hour`,
      },
    };
  }

  const fail = (failure: AskFailure, servedModel: string | null = null): Asked<T> => ({
    hash,
    source: "model",
    answer: null,
    servedModel,
    failure,
  });
  let text: string;
  let servedModel: string;
  try {
    ({ text, servedModel } = await model.answer(request));
  } catch (error) {
    if (error instanceof ModelError) {
      return fail({ reason: error.reason, message: error.message });
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail({ reason: "malformed", message: "the answer was not JSON" }, servedModel);
  }
  const parsed = envelope.safeParse(json);
  if (!parsed.success) {
    return fail(
      {
        reason: "malformed",
        message: `the answer did not follow the schema: ${z.prettifyError(parsed.error)}`,
      },
      servedModel,
    );
  }
  await db
    .insert(agentAnswer)
    .values({
      practiceId,
      inputSha256: hash,
      job: request.job,
      modelId: model.settings.model,
      servedModel,
      answer: asJson(json),
    })
    .onConflictDoNothing();
  return { hash, source: "model", answer: parsed.data, servedModel, failure: null };
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
