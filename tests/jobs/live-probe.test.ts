import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { DEPLOYMENT_URL, liveHealthUrl, liveOrigin, probeLive } from "@/jobs/live-probe";

const HEALTH_URL = "https://pawhold.onrender.com/api/health";

const HEALTHY = { status: "ok", database: "reached", commit: "0233063".padEnd(40, "0") };

/** What a stubbed fetch was asked, in order. */
interface Asked {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * A fetch that gives each call the next answer in turn (the last one again
 * once they run out) and records what it was asked.
 *
 * @param answers - What each call does: a response to give, or an error to throw.
 * @returns The stub and its record.
 */
function stubFetch(...answers: (() => Response | Error)[]): {
  fetch: typeof fetch;
  asked: Asked[];
} {
  const asked: Asked[] = [];
  const stub: typeof fetch = async (input, init) => {
    asked.push({ url: String(input), init });
    const answer = answers[Math.min(asked.length, answers.length) - 1]!();
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return { fetch: stub, asked };
}

/**
 * A fetch that never answers: it rejects only when its signal aborts, as the
 * platform's does.
 *
 * @returns The stub.
 */
function silentFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
    });
}

/**
 * An answer for `stubFetch`: a JSON body under a status.
 *
 * @param status - The HTTP status.
 * @param body - The body.
 * @returns The answer.
 */
const json = (status: number, body: unknown) => (): Response => Response.json(body, { status });

/** The wait before the retry, not waited. */
const noPause = async (): Promise<void> => {};

describe("the hourly job's probe of the live service (U14)", () => {
  it("finds the service healthy on a 200 with the database reached, asking once", async () => {
    const { fetch, asked } = stubFetch(json(200, HEALTHY));

    const probe = await probeLive({ url: HEALTH_URL, fetch, pause: noPause });

    expect(probe).toEqual({
      healthy: true,
      url: HEALTH_URL,
      attempts: 1,
      commit: HEALTHY.commit,
    });
    expect(asked.map((one) => one.url)).toEqual([HEALTH_URL]);
    expect(asked[0]!.init?.cache).toBe("no-store");
    expect(asked[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails on a 503 such as a suspended service answers, after one retry", async () => {
    const suspended = (): Response =>
      new Response("<html><body>Service Suspended</body></html>", {
        status: 503,
        headers: { "content-type": "text/html" },
      });
    const { fetch, asked } = stubFetch(suspended);
    const paused: number[] = [];

    const probe = await probeLive({
      url: HEALTH_URL,
      fetch,
      retryAfterMs: 5_000,
      pause: async (ms) => {
        paused.push(ms);
      },
    });

    expect(probe).toEqual({
      healthy: false,
      url: HEALTH_URL,
      attempts: 2,
      saw: "HTTP 503 with a body that is not the health check's JSON",
    });
    expect(asked).toHaveLength(2);
    expect(paused).toEqual([5_000]);
  });

  it("fails on the health check's own 503, naming what it reported", async () => {
    const { fetch } = stubFetch(
      json(503, { status: "unavailable", database: "unreachable", commit: null }),
    );

    const probe = await probeLive({ url: HEALTH_URL, fetch, pause: noPause });

    expect(probe).toMatchObject({
      healthy: false,
      attempts: 2,
      saw: 'HTTP 503 with status "unavailable" and database "unreachable"',
    });
  });

  it("fails on a timeout, each attempt bounded", async () => {
    const started = Date.now();

    const probe = await probeLive({
      url: HEALTH_URL,
      fetch: silentFetch(),
      timeoutMs: 30,
      pause: noPause,
    });

    expect(probe).toEqual({
      healthy: false,
      url: HEALTH_URL,
      attempts: 2,
      saw: "no answer in 30 ms",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("bounds the body as well: an answer whose headers come and whose body never ends is a timeout", async () => {
    const server = createServer((_, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"status":"ok",');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`;
    const started = Date.now();

    try {
      const probe = await probeLive({ url, timeoutMs: 150, pause: noPause });

      expect(probe).toEqual({ healthy: false, url, attempts: 2, saw: "no answer in 150 ms" });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("judges health by the status and the database alone, whatever the commit is or is not", async () => {
    for (const [commit, read] of [
      [{}, null],
      [{ commit: null }, null],
      [{ commit: 20261013 }, null],
      [{ commit: { sha: "0233063" } }, null],
      [{ commit: "0233063" }, "0233063"],
    ] as const) {
      const { fetch } = stubFetch(json(200, { status: "ok", database: "reached", ...commit }));

      const probe = await probeLive({ url: HEALTH_URL, fetch, pause: noPause });

      expect(probe, JSON.stringify(commit)).toEqual({
        healthy: true,
        url: HEALTH_URL,
        attempts: 1,
        commit: read,
      });
    }
  });

  it("fails on a 200 whose body is not the health check's JSON", async () => {
    const page = (): Response =>
      new Response("<!doctype html><title>pawhold</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    for (const wrong of [page, json(200, ["ok"]), json(200, { status: "ok" }), json(200, null)]) {
      const probe = await probeLive({
        url: HEALTH_URL,
        fetch: stubFetch(wrong).fetch,
        pause: noPause,
      });

      expect(probe).toMatchObject({
        healthy: false,
        attempts: 2,
        saw: "HTTP 200 with a body that is not the health check's JSON",
      });
    }
  });

  it("fails on a 200 that does not say ok with the database reached", async () => {
    const { fetch } = stubFetch(json(200, { status: "ok", database: "unreachable" }));

    const probe = await probeLive({ url: HEALTH_URL, fetch, pause: noPause });

    expect(probe).toMatchObject({
      healthy: false,
      saw: 'HTTP 200 with status "ok" and database "unreachable"',
    });
  });

  it("fails on the right body under the wrong status", async () => {
    const { fetch } = stubFetch(json(500, HEALTHY));

    const probe = await probeLive({ url: HEALTH_URL, fetch, pause: noPause });

    expect(probe).toMatchObject({
      healthy: false,
      saw: 'HTTP 500 with status "ok" and database "reached"',
    });
  });

  it("fails when the request itself fails, naming the cause", async () => {
    const refused = (): Error =>
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND pawhold.onrender.com"), {
          code: "ENOTFOUND",
        }),
      });
    const { fetch } = stubFetch(refused);

    const probe = await probeLive({ url: HEALTH_URL, fetch, pause: noPause });

    expect(probe).toEqual({
      healthy: false,
      url: HEALTH_URL,
      attempts: 2,
      saw: "the request failed (fetch failed: ENOTFOUND)",
    });
  });

  it("passes when the one retry finds the service healthy, so a single blip is not an outage", async () => {
    const { fetch, asked } = stubFetch(() => new Response("", { status: 502 }), json(200, HEALTHY));

    const probe = await probeLive({ url: HEALTH_URL, fetch, pause: noPause });

    expect(probe).toMatchObject({ healthy: true, attempts: 2 });
    expect(asked).toHaveLength(2);
  });

  it("keeps what a strange body says short and on one line", async () => {
    const { fetch } = stubFetch(json(200, { status: "x".repeat(500), database: "one\ntwo" }));

    const probe = await probeLive({ url: HEALTH_URL, fetch, pause: noPause });

    expect(probe.healthy).toBe(false);
    const saw = probe.healthy ? "" : probe.saw;
    expect(saw).not.toContain("\n");
    expect(saw.length).toBeLessThan(160);
  });

  it("keeps what a strange failure says short and on one line", async () => {
    const { fetch } = stubFetch(() => new Error(`one\r\ntwo ${"x".repeat(500)}`));

    const probe = await probeLive({ url: HEALTH_URL, fetch, pause: noPause });

    expect(probe.healthy).toBe(false);
    const saw = probe.healthy ? "" : probe.saw;
    expect(saw).toMatch(/^the request failed \(one two x+\.\.\.\)$/);
    expect(saw.length).toBeLessThan(160);
  });
});

describe("the address the probe asks (U14)", () => {
  it("is the deployment's public health check unless PAWHOLD_LIVE_URL points elsewhere", () => {
    expect(DEPLOYMENT_URL).toBe("https://pawhold.onrender.com");
    expect(liveHealthUrl({})).toBe(HEALTH_URL);
    expect(liveHealthUrl({ PAWHOLD_LIVE_URL: "" })).toBe(HEALTH_URL);
    expect(liveHealthUrl({ PAWHOLD_LIVE_URL: "https://pawhold-fork.onrender.com/" })).toBe(
      "https://pawhold-fork.onrender.com/api/health",
    );
    expect(liveHealthUrl({ PAWHOLD_LIVE_URL: "http://127.0.0.1:3000" })).toBe(
      "http://127.0.0.1:3000/api/health",
    );
  });

  it("is the health check of the origin the live smoke walks", () => {
    expect(liveOrigin({})).toBe(DEPLOYMENT_URL);
    expect(liveOrigin({ PAWHOLD_LIVE_URL: "https://Pawhold.onrender.com:443/" })).toBe(
      "https://pawhold.onrender.com",
    );
    expect(liveHealthUrl({ PAWHOLD_LIVE_URL: "https://Pawhold.onrender.com:443/" })).toBe(
      HEALTH_URL,
    );
  });

  it("refuses an address that is not an http or https origin, naming the variable", () => {
    for (const wrong of [
      "pawhold.onrender.com",
      "ftp://pawhold.onrender.com",
      "https://pawhold.onrender.com/api/health",
      "https://pawhold.onrender.com/?x=1",
    ]) {
      expect(() => liveHealthUrl({ PAWHOLD_LIVE_URL: wrong }), wrong).toThrow(/PAWHOLD_LIVE_URL/);
    }
  });
});
