import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { agentFromEnvironment } from "@/agent/environment";
import { MODEL_SETTINGS, ModelError } from "@/agent/model";
import { fileRecordedStore } from "@/agent/recorded";
import { DRAFT_FORMAT } from "@/agent/schema";
import { EnvironmentError } from "@/env";

import { primeAnswer } from "../support/agent";
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

  describe("with AGENT_RECORDED_DIR (the browser walks' double)", () => {
    const made: string[] = [];
    const directory = (): string => {
      const path = mkdtempSync(join(tmpdir(), "pawhold-recorded-"));
      made.push(path);
      return path;
    };
    afterAll(() => {
      for (const path of made) {
        rmSync(path, { recursive: true, force: true });
      }
    });

    it("answers from the recorded answers and never live, even with a key", async () => {
      const recorded = directory();
      primeAnswer(fileRecordedStore(recorded), REQUEST, { lines: [], unmatched: [] });
      const agent = agentFromEnvironment(db, {
        OPENAI_API_KEY: "sk-test",
        AGENT_RECORDED_DIR: recorded,
      });

      expect(agent.live).toBe(false);
      expect((await agent.model.answer(REQUEST)).text).toBe('{"lines":[],"unmatched":[]}');
    });

    it("reads several directories joined by the path delimiter, the first that has an answer", async () => {
      const empty = directory();
      const second = directory();
      primeAnswer(fileRecordedStore(second), REQUEST, "from the second");
      const agent = agentFromEnvironment(db, {
        AGENT_RECORDED_DIR: [empty, second].join(delimiter),
      });

      expect((await agent.model.answer(REQUEST)).text).toBe("from the second");
    });

    it("is not_recorded for a request no directory holds, so the vet fills the estimate", async () => {
      const agent = agentFromEnvironment(db, { AGENT_RECORDED_DIR: directory() });
      const error = await agent.model.answer(REQUEST).catch((caught: unknown) => caught);

      expect((error as ModelError).reason).toBe("not_recorded");
    });
  });
});
