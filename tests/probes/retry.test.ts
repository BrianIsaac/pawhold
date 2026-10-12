import { describe, expect, it } from "vitest";

import { retryingFetch } from "../../probes/retry";

const URL_BASE = "https://api-m.sandbox.paypal.com";

/**
 * A fetch that fails with no answer a number of times, then answers 200.
 *
 * @param failures - How many sends fail first.
 * @returns The fetch and how many times it was called.
 */
function flaky(failures: number) {
  let calls = 0;
  const fetchImpl: typeof fetch = () => {
    calls += 1;
    return calls <= failures
      ? Promise.reject(new TypeError("fetch failed"))
      : Promise.resolve(new Response("{}", { status: 200 }));
  };
  return { fetchImpl, calls: () => calls };
}

const options = { attempts: 3, delayMs: 0, sleep: () => Promise.resolve() };

describe("the probes' retrying fetch", () => {
  it("sends a GET, the token call and a POST with a PayPal-Request-Id again when no answer came", async () => {
    for (const [path, init] of [
      ["/v2/payments/authorizations/A1", { method: "GET" }],
      ["/v1/oauth2/token", { method: "POST" }],
      [
        "/v2/payments/authorizations/A1/void",
        { method: "POST", headers: { "paypal-request-id": "rid" } },
      ],
    ] as const) {
      const { fetchImpl, calls } = flaky(2);
      const answer = await retryingFetch(fetchImpl, options)(`${URL_BASE}${path}`, init);
      expect(answer.status).toBe(200);
      expect(calls()).toBe(3);
    }
  });

  it("never sends a POST without a PayPal-Request-Id twice", async () => {
    const { fetchImpl, calls } = flaky(1);
    await expect(
      retryingFetch(fetchImpl, options)(`${URL_BASE}/v2/checkout/orders`, { method: "POST" }),
    ).rejects.toThrow("fetch failed");
    expect(calls()).toBe(1);
  });

  it("gives up after the attempts allowed", async () => {
    const { fetchImpl, calls } = flaky(5);
    await expect(
      retryingFetch(fetchImpl, options)(`${URL_BASE}/v2/payments/captures/C1`),
    ).rejects.toThrow("fetch failed");
    expect(calls()).toBe(3);
  });

  it("retries a 5xx or 429 answer to an idempotent request, and gives the last answer when it persists", async () => {
    const statuses = [503, 429, 200];
    let calls = 0;
    const answering: typeof fetch = () =>
      Promise.resolve(new Response("{}", { status: statuses[calls++] ?? 500 }));

    const answer = await retryingFetch(answering, options)(`${URL_BASE}/v2/payments/captures/C1`);
    expect(answer.status).toBe(200);
    expect(calls).toBe(3);

    calls = 0;
    const always503: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(new Response("{}", { status: 503 }));
    };
    expect(
      (await retryingFetch(always503, options)(`${URL_BASE}/v2/payments/captures/C1`)).status,
    ).toBe(503);
    expect(calls).toBe(3);
  });

  it("never retries a 4xx other than 429, nor any answer to a POST without a PayPal-Request-Id", async () => {
    for (const [status, init] of [
      [422, { method: "GET" }],
      [503, { method: "POST" }],
    ] as const) {
      let calls = 0;
      const answering: typeof fetch = () => {
        calls += 1;
        return Promise.resolve(new Response("{}", { status }));
      };
      const answer = await retryingFetch(answering, options)(
        `${URL_BASE}/v2/checkout/orders`,
        init,
      );
      expect(answer.status).toBe(status);
      expect(calls).toBe(1);
    }
  });
});
