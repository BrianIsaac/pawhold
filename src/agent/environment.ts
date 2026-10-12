import type { Executor } from "@/db/client";
import { openaiEnvironment, readEnvironment } from "@/env";

import type { AgentDependencies } from "./jobs";
import { agentEnvironment } from "./limits";
import { type DraftModel, MODEL_SETTINGS, ModelError } from "./model";
import { createOpenAIModel } from "./openai";

/** The agent as the server runs it, and whether it can reach the model. */
export interface ServerAgent extends AgentDependencies {
  readonly draftsPerHour: number | null;
  /** False when no key is set: every draft is an empty estimate. */
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
 * `AGENT_DRAFTS_PER_HOUR`.
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
