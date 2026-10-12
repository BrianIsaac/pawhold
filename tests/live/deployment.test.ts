import { describe, expect, it } from "vitest";

import { awaitDeployment } from "./support/deployment";

const PUSHED = "1111111111111111111111111111111111111111";
const EARLIER = "9f9fb1c0853532e7c153df42036168b9bac38ef7";

/**
 * A clock the waits move forward, and a fetch that answers in turn.
 *
 * @param answers - What each ask answers: a status and a body, or an error.
 * @returns The dependencies and what was asked.
 */
function bed(answers: readonly ({ status: number; body: unknown } | Error)[]) {
  let now = 0;
  const asked: string[] = [];
  let turn = 0;
  return {
    asked,
    elapsed: () => now,
    dependencies: {
      fetch: async (url: string): Promise<Response> => {
        asked.push(url);
        const answer = answers[Math.min(turn++, answers.length - 1)]!;
        if (answer instanceof Error) {
          throw answer;
        }
        return Response.json(answer.body, { status: answer.status });
      },
      sleep: async (ms: number): Promise<void> => {
        now += ms;
      },
      now: () => now,
    },
  };
}

const up = (commit: string) => ({
  status: 200,
  body: { status: "ok", database: "reached", commit },
});

describe("waiting for the pushed commit on the deployment (U10)", () => {
  it("answers once the health check reports the pushed commit with the database reached", async () => {
    const { dependencies, asked, elapsed } = bed([up(EARLIER), up(EARLIER), up(PUSHED)]);

    const result = await awaitDeployment(
      {
        baseUrl: "https://pawhold.onrender.com",
        commit: PUSHED,
        timeoutMs: 600_000,
        everyMs: 15_000,
      },
      dependencies,
    );

    expect(result).toEqual({ deployed: true, commit: PUSHED, waitedMs: 30_000, asks: 3 });
    expect(asked).toEqual(Array(3).fill("https://pawhold.onrender.com/api/health"));
    expect(elapsed()).toBe(30_000);
  });

  it("keeps asking through a deploy's 503s and dropped requests", async () => {
    const { dependencies } = bed([
      new TypeError("fetch failed"),
      { status: 503, body: { status: "unavailable", database: "unreachable", commit: PUSHED } },
      { status: 502, body: "Bad Gateway" },
      up(PUSHED),
    ]);

    const result = await awaitDeployment(
      {
        baseUrl: "https://pawhold.onrender.com",
        commit: PUSHED,
        timeoutMs: 600_000,
        everyMs: 15_000,
      },
      dependencies,
    );

    expect(result).toMatchObject({ deployed: true, asks: 4 });
  });

  it("gives up after the limit, saying what the deployment last reported", async () => {
    const { dependencies } = bed([up(EARLIER)]);

    const result = await awaitDeployment(
      {
        baseUrl: "https://pawhold.onrender.com",
        commit: PUSHED,
        timeoutMs: 600_000,
        everyMs: 15_000,
      },
      dependencies,
    );

    expect(result).toEqual({
      deployed: false,
      waitedMs: 600_000,
      asks: 41,
      last: `200 ok, database reached, commit ${EARLIER}`,
    });
  });

  it("says so when the deployment never answered", async () => {
    const { dependencies } = bed([new TypeError("fetch failed")]);

    const result = await awaitDeployment(
      {
        baseUrl: "https://pawhold-gone.onrender.com",
        commit: PUSHED,
        timeoutMs: 60_000,
        everyMs: 15_000,
      },
      dependencies,
    );

    expect(result).toEqual({
      deployed: false,
      waitedMs: 60_000,
      asks: 5,
      last: "no answer: fetch failed",
    });
  });

  it("refuses a commit that is not a full SHA", async () => {
    const { dependencies } = bed([up(PUSHED)]);

    await expect(
      awaitDeployment(
        {
          baseUrl: "https://pawhold.onrender.com",
          commit: "main",
          timeoutMs: 60_000,
          everyMs: 15_000,
        },
        dependencies,
      ),
    ).rejects.toThrow("the pushed commit must be a full 40-character SHA");
  });
});
