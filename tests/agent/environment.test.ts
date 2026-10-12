import { describe, expect, it } from "vitest";

import { agentFromEnvironment } from "@/agent/environment";
import { MODEL_SETTINGS, ModelError } from "@/agent/model";
import { DRAFT_FORMAT } from "@/agent/schema";
import { EnvironmentError } from "@/env";

import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();

const REQUEST = {
  job: "draft" as const,
  promptVersion: "draft.v1",
  instructions: "x",
  input: "y",
  image: null,
  format: DRAFT_FORMAT,
};

describe("the agent as the server builds it", () => {
  it("asks OpenAI when OPENAI_API_KEY is set, under the default cap", () => {
    const agent = agentFromEnvironment(db, { OPENAI_API_KEY: "sk-test" });
    expect(agent.model.settings).toBe(MODEL_SETTINGS);
    expect(agent.draftsPerHour).toBe(40);
    expect(agent.live).toBe(true);
  });

  it("without a key, every ask is unavailable, so every draft is the vet's to fill", async () => {
    const agent = agentFromEnvironment(db, {});
    expect(agent.live).toBe(false);
    const error = await agent.model.answer(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).reason).toBe("unavailable");
  });

  it("reads the cap from AGENT_DRAFTS_PER_HOUR", () => {
    expect(agentFromEnvironment(db, { AGENT_DRAFTS_PER_HOUR: "off" }).draftsPerHour).toBeNull();
    expect(() => agentFromEnvironment(db, { AGENT_DRAFTS_PER_HOUR: "lots" })).toThrow(
      EnvironmentError,
    );
  });
});
