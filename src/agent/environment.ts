import { delimiter } from "node:path";

import type { Executor } from "@/db/client";
import { openaiEnvironment, readEnvironment } from "@/env";

import type { AgentDependencies } from "./jobs";
import { agentEnvironment } from "./limits";
import { type DraftModel, MODEL_SETTINGS, ModelError } from "./model";
import { createOpenAIModel } from "./openai";
import { createRecordedModel, fileRecordedStore, type RecordedStore } from "./recorded";

/** The agent as the server runs it, and whether it can reach the model. */
export interface ServerAgent extends AgentDependencies {
  readonly draftsPerHour: number | null;
  /** False when no key is set, or the recorded double answers: no provider is asked. */
  readonly live: boolean;
}

/**
 * A model that is never reachable: before a key is set, every ask fails as
 * unavailable and the vet fills the estimate by hand.
 *
 * @returns The model.
 */
export function unavailableModel(): DraftModel {
  return {
    settings: MODEL_SETTINGS,
    answer: async () => {
      throw new ModelError("unavailable", "no model key is configured on this server");
    },
  };
}

/**
 * Builds the agent from the environment: OpenAI when `OPENAI_API_KEY` is
 * set, else a model that is never reachable; the cap from
 * `AGENT_DRAFTS_PER_HOUR`. With `AGENT_RECORDED_DIR` (one directory of
 * recorded answers, or several joined by the path delimiter) the model is
 * the recorded double instead, whatever key is set: the browser walks run the
 * built server on it, so no provider is ever asked under test.
 *
 * @param db - The database.
 * @param source - The environment; `process.env` by default.
 * @returns The agent.
 * @throws EnvironmentError when `AGENT_DRAFTS_PER_HOUR` is malformed.
 */
export function agentFromEnvironment(
  db: Executor,
  source: Record<string, string | undefined> = process.env,
): ServerAgent {
  const { AGENT_DRAFTS_PER_HOUR } = readEnvironment(agentEnvironment, source);
  const recorded = source.AGENT_RECORDED_DIR?.split(delimiter).filter((path) => path !== "");
  if (recorded && recorded.length > 0) {
    return {
      db,
      model: createRecordedModel(firstAnswering(recorded.map(fileRecordedStore))),
      draftsPerHour: AGENT_DRAFTS_PER_HOUR,
      live: false,
    };
  }
  const key = openaiEnvironment.safeParse(source);
  return {
    db,
    model: key.success
      ? createOpenAIModel({ apiKey: key.data.OPENAI_API_KEY })
      : unavailableModel(),
    draftsPerHour: AGENT_DRAFTS_PER_HOUR,
    live: key.success,
  };
}

/**
 * Recorded answers read from several stores, the first holding one winning.
 *
 * @param stores - The stores, in order.
 * @returns A store that reads them; it is never written to.
 */
function firstAnswering(stores: readonly RecordedStore[]): RecordedStore {
  return {
    get: (hash) => {
      for (const store of stores) {
        const answer = store.get(hash);
        if (answer) {
          return answer;
        }
      }
      return undefined;
    },
    put: () => {
      throw new Error("the server's recorded answers are read only");
    },
  };
}
