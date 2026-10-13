import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createPayPalClient,
  PayPalContractError,
  PayPalError,
  PayPalTransportError,
} from "@/paypal/client";

import { paypalFixture, paypalFixtureText } from "../support/fixtures";
import { startMockPayPal } from "../support/mock-paypal";
import { recordedAnswer } from "../support/recorded";

const paypal = startMockPayPal();

const CLIENT_ID = "FAKE-CLIENT-ID";
const CLIENT_SECRET = "FAKE-CLIENT-SECRET-NOT-REAL";
const TOKEN = paypalFixture("api/oauth-token.json") as { expires_in: number };
const AUTHORIZATION = { id: "91T13242G72341823", status: "CREATED" };
const authorization = z.object({ id: z.string(), status: z.string() });

/**
 * A client pointed at the mock PayPal with a clock the test controls.
 *
 * @param clock - Milliseconds since the epoch, read on every call.
 * @returns The client.
 */
function client(clock: { now: number } = { now: Date.UTC(2026, 9, 12) }) {
  return createPayPalClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    environment: "sandbox",
    baseUrl: paypal.baseUrl(),
    now: () => clock.now,
  });
}

const tokenCalls = () => paypal.requests.filter((r) => r.path === "/v1/oauth2/token");

/**
 * A client over a fetch that answers by path, for what the mock server cannot
 * give: a response header, a body that is not JSON, an answer that is late.
 * Every request is kept, in order, as `METHOD /path`.
 *
 * @param routes - The answer to each path, built afresh for every request.
 * @param timeoutMs - How long the client waits on each request.
 * @returns The client and the requests it sent.
 */
function stubbed(
  routes: Record<string, (signal: AbortSignal) => Response | Promise<Response>>,
  timeoutMs?: number,
) {
  const sent: string[] = [];
  const answering = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    sent.push(`${init?.method} ${path}`);
    const route = routes[path];
    if (!route) {
      throw new Error(`no stubbed answer for ${path}`);
    }
    return route(init!.signal!);
  };
  const paypalClient = createPayPalClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    environment: "sandbox",
    baseUrl: "https://paypal.invalid",
    fetch: answering as typeof fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { client: paypalClient, sent };
}

const AUTHORIZATION_PATH = "/v2/payments/authorizations/91T13242G72341823";

describe("the PayPal client's OAuth token", () => {
  it("asks for a client-credentials token with basic auth, as the docs' cURL does", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
    paypal.on("GET /v2/payments/authorizations/91T13242G72341823", {
      status: 200,
      body: AUTHORIZATION,
    });

    await client().get("/v2/payments/authorizations/91T13242G72341823", {
      response: authorization,
    });

    const [call] = tokenCalls();
    expect(call!.method).toBe("POST");
    expect(call!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call!.headers.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    );
    expect(call!.body).toBe("grant_type=client_credentials");
    const api = paypal.requests.find((r) => r.path.startsWith("/v2/"));
    expect(api!.headers.authorization).toBe("Bearer A21AA-FAKE-ACCESS-TOKEN-FOR-TESTS-ONLY");
  });

  it("caches the token across calls while it is valid", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
    paypal.on("GET /v2/payments/authorizations/91T13242G72341823", {
      status: 200,
      body: AUTHORIZATION,
    });
    const clock = { now: Date.UTC(2026, 9, 12) };
    const paypalClient = client(clock);

    await paypalClient.get("/v2/payments/authorizations/91T13242G72341823", {
      response: authorization,
    });
    clock.now += (TOKEN.expires_in - 600) * 1000;
    await paypalClient.get("/v2/payments/authorizations/91T13242G72341823", {
      response: authorization,
    });

    expect(tokenCalls()).toHaveLength(1);
  });

  it("fetches a new token before the old one runs out", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
    paypal.on("GET /v2/payments/authorizations/91T13242G72341823", {
      status: 200,
      body: AUTHORIZATION,
    });
    const clock = { now: Date.UTC(2026, 9, 12) };
    const paypalClient = client(clock);

    await paypalClient.get("/v2/payments/authorizations/91T13242G72341823", {
      response: authorization,
    });
    clock.now += (TOKEN.expires_in - 60) * 1000;
    await paypalClient.get("/v2/payments/authorizations/91T13242G72341823", {
      response: authorization,
    });

    expect(tokenCalls()).toHaveLength(2);
  });

  it("shares one token request between calls made at once", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
    paypal.on("GET /v2/payments/authorizations/91T13242G72341823", {
      status: 200,
      body: AUTHORIZATION,
    });
    const paypalClient = client();

    await Promise.all(
      [1, 2, 3].map(() =>
        paypalClient.get("/v2/payments/authorizations/91T13242G72341823", {
          response: authorization,
        }),
      ),
    );

    expect(tokenCalls()).toHaveLength(1);
  });

  it("refreshes the token on a 401 and retries once with the same PayPal-Request-Id", async () => {
    paypal.on(
      "POST /v1/oauth2/token",
      { status: 200, body: { ...TOKEN, access_token: "A21AA-FAKE-FIRST" } },
      { status: 200, body: { ...TOKEN, access_token: "A21AA-FAKE-SECOND" } },
    );
    paypal.on(
      "POST /v2/payments/authorizations/91T13242G72341823/void",
      { status: 401, body: paypalFixture("api/api-401-invalid-token.json") },
      { status: 204, body: null },
    );

    const answer = await client().post("/v2/payments/authorizations/91T13242G72341823/void", {
      requestId: "8f0f8a3e-0000-8000-8000-000000000001",
      response: z.null(),
    });

    expect(answer.status).toBe(204);
    expect(tokenCalls()).toHaveLength(2);
    const voids = paypal.requests.filter((r) => r.path.endsWith("/void"));
    expect(voids.map((r) => r.headers.authorization)).toEqual([
      "Bearer A21AA-FAKE-FIRST",
      "Bearer A21AA-FAKE-SECOND",
    ]);
    expect(voids.map((r) => r.headers["paypal-request-id"])).toEqual([
      "8f0f8a3e-0000-8000-8000-000000000001",
      "8f0f8a3e-0000-8000-8000-000000000001",
    ]);
  });

  it("gives up after one refresh when PayPal still answers 401", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
    paypal.on("GET /v2/payments/authorizations/91T13242G72341823", {
      status: 401,
      body: paypalFixture("api/api-401-invalid-token.json"),
    });

    const failure = client().get("/v2/payments/authorizations/91T13242G72341823", {
      response: authorization,
    });

    await expect(failure).rejects.toMatchObject({ status: 401, name: "invalid_token" });
    expect(tokenCalls()).toHaveLength(2);
  });

  it("raises PayPal's identity error when the credentials are refused", async () => {
    paypal.on("POST /v1/oauth2/token", {
      status: 401,
      body: paypalFixture("api/oauth-401-invalid-client.json"),
    });

    const error = await client()
      .get("/v2/payments/authorizations/91T13242G72341823", { response: authorization })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PayPalError);
    expect(error).toMatchObject({
      status: 401,
      name: "invalid_client",
      message: "Client Authentication failed",
    });
    expect(String((error as Error).message)).not.toContain(CLIENT_SECRET);
    expect(tokenCalls()).toHaveLength(1);
  });
});

describe("the PayPal client's errors", () => {
  it("carries name, details and debug_id from the documented void refusal", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
    paypal.on("POST /v2/payments/authorizations/91T13242G72341823/void", {
      status: 422,
      body: paypalFixture("api/void-422-previously-captured.json"),
    });

    const error = await client()
      .post("/v2/payments/authorizations/91T13242G72341823/void", {
        requestId: "8f0f8a3e-0000-8000-8000-000000000002",
        response: z.null(),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PayPalError);
    const paypalError = error as PayPalError;
    expect(paypalError.status).toBe(422);
    expect(paypalError.name).toBe("UNPROCESSABLE_ENTITY");
    expect(paypalError.debugId).toBe("a7b0de7cb97ad");
    expect(paypalError.details).toEqual([
      {
        issue: "PREVIOUSLY_CAPTURED",
        description: "Authorization has been previously captured and cannot be voided.",
      },
    ]);
    expect(paypalError.hasIssue("PREVIOUSLY_CAPTURED")).toBe(true);
  });

  it("matches the reauthorise refusal by its issue, whatever the name's spelling", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
    paypal.on("POST /v2/payments/authorizations/91T13242G72341823/reauthorize", {
      status: 422,
      body: paypalFixture("api/reauthorize-422-too-soon.json"),
    });

    const error = (await client()
      .post("/v2/payments/authorizations/91T13242G72341823/reauthorize", {
        requestId: "8f0f8a3e-0000-8000-8000-000000000003",
        body: {},
        response: authorization,
      })
      .catch((caught: unknown) => caught)) as PayPalError;

    expect(error.name).toBe("UNPROCCESSABLE_ENTITY");
    expect(error.hasIssue("REAUTHORIZATION_TOO_SOON")).toBe(true);
    expect(error.debugId).toBe("90bff07028f7f");
  });

  it("refuses an answer that does not match the shape the caller expects", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
    paypal.on("GET /v2/payments/authorizations/91T13242G72341823", {
      status: 200,
      body: { status: "CREATED" },
    });

    await expect(
      client().get("/v2/payments/authorizations/91T13242G72341823", { response: authorization }),
    ).rejects.toBeInstanceOf(PayPalContractError);
  });

  it("reports a body that fails mid-read as a transport failure, not a raw error", async () => {
    const failing = async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/oauth2/token")) {
        return Response.json(TOKEN);
      }
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(body, { status: 201 });
    };
    const paypalClient = createPayPalClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      environment: "sandbox",
      baseUrl: "https://paypal.invalid",
      fetch: failing as typeof fetch,
    });

    await expect(
      paypalClient.post("/v2/payments/authorizations/91T13242G72341823/capture", {
        requestId: "8f0f8a3e-0000-8000-8000-000000000005",
        body: {},
        response: authorization,
      }),
    ).rejects.toBeInstanceOf(PayPalTransportError);
  });

  it("sends a JSON body and PayPal-Request-Id on a POST", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
    paypal.on("POST /v2/payments/authorizations/91T13242G72341823/capture", {
      status: 201,
      body: { id: "3C679366HH908993F", status: "COMPLETED" },
    });

    await client().post("/v2/payments/authorizations/91T13242G72341823/capture", {
      requestId: "8f0f8a3e-0000-8000-8000-000000000004",
      body: { amount: { value: "10.00", currency_code: "GBP" }, final_capture: true },
      response: authorization,
    });

    const capture = paypal.requests.find((r) => r.path.endsWith("/capture"));
    expect(capture!.headers["content-type"]).toBe("application/json");
    expect(capture!.headers["paypal-request-id"]).toBe("8f0f8a3e-0000-8000-8000-000000000004");
    expect(JSON.parse(capture!.body)).toEqual({
      amount: { value: "10.00", currency_code: "GBP" },
      final_capture: true,
    });
  });
});

describe("PayPal's debug id on an error (the sandbox's recorded answers carry `Paypal-Debug-Id`)", () => {
  /** The header's id on P4's recorded token answer, whose body the recorder never read. */
  const headerId = () => recordedAnswer("P4", "POST", /^\/v1\/oauth2\/token$/).debugId!;
  const TRAIL_LIMIT = 255;

  /**
   * An error answer as PayPal sends one.
   *
   * @param status - The HTTP status.
   * @param body - The body text.
   * @param debugId - The `Paypal-Debug-Id` header, when PayPal sends one.
   * @returns The route.
   */
  const refusing = (status: number, body: string, debugId?: string) => () =>
    new Response(body, {
      status,
      headers: {
        "content-type": "application/json",
        ...(debugId === undefined ? {} : { "paypal-debug-id": debugId }),
      },
    });

  /**
   * The error a capture gets when PayPal answers it with a refusal.
   *
   * @param refusal - The route answering the capture.
   * @returns What the client threw.
   */
  const captureRefused = async (refusal: () => Response): Promise<PayPalError> => {
    const { client: paypalClient } = stubbed({
      "/v1/oauth2/token": () => Response.json(TOKEN),
      [`${AUTHORIZATION_PATH}/capture`]: refusal,
    });
    const error = await paypalClient
      .post(`${AUTHORIZATION_PATH}/capture`, {
        requestId: "8f0f8a3e-0000-8000-8000-000000000006",
        body: {},
        response: authorization,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PayPalError);
    return error as PayPalError;
  };

  it("was sent on the recorded token answer, whose body the recorder never read", () => {
    expect(recordedAnswer("P4", "POST", /^\/v1\/oauth2\/token$/).status).toBe(200);
    expect(headerId()).toMatch(/^[0-9a-f]{10,}$/);
  });

  it("is kept from the header when the credentials are refused: the identity body has none", async () => {
    const { client: paypalClient } = stubbed({
      "/v1/oauth2/token": refusing(
        401,
        paypalFixtureText("api/oauth-401-invalid-client.json"),
        headerId(),
      ),
    });

    const error = await paypalClient
      .get(AUTHORIZATION_PATH, { response: authorization })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PayPalError);
    expect(error).toMatchObject({ status: 401, name: "invalid_client", debugId: headerId() });
  });

  it("is kept from the header when the token is refused on the call and again after the refresh", async () => {
    const { client: paypalClient, sent } = stubbed({
      "/v1/oauth2/token": () => Response.json(TOKEN),
      [AUTHORIZATION_PATH]: refusing(
        401,
        paypalFixtureText("api/api-401-invalid-token.json"),
        headerId(),
      ),
    });

    const error = await paypalClient
      .get(AUTHORIZATION_PATH, { response: authorization })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 401, name: "invalid_token", debugId: headerId() });
    expect(sent.filter((request) => request.endsWith(AUTHORIZATION_PATH))).toHaveLength(2);
  });

  it("is kept from the header on an answer that is not JSON, named by its status", async () => {
    const error = await captureRefused(
      () =>
        new Response("<html><body>Service Unavailable</body></html>", {
          status: 503,
          headers: { "content-type": "text/html", "paypal-debug-id": headerId() },
        }),
    );

    expect(error).toMatchObject({
      status: 503,
      name: "HTTP_503",
      debugId: headerId(),
      details: [],
    });
  });

  it("is the body's where PayPal gives both: negative testing's recorded refusal carries two", async () => {
    const refusal = recordedAnswer("P5A", "POST", /\/capture$/);
    const inBody = (refusal.responseBody as { debug_id: string }).debug_id;
    expect(refusal.debugId).not.toBe(inBody);

    const error = await captureRefused(
      refusing(refusal.status!, JSON.stringify(refusal.responseBody), refusal.debugId!),
    );

    expect(error).toMatchObject({ status: 422, debugId: inBody });
    expect(error.hasIssue("AUTHORIZATION_EXPIRED")).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["longer than any id the audit trail keeps", "b".repeat(TRAIL_LIMIT + 1)],
  ])("is the header's when the body's debug_id is %s", async (_case, inBody) => {
    const body = JSON.stringify({
      name: "UNPROCESSABLE_ENTITY",
      debug_id: inBody,
      details: [{ issue: "AUTHORIZATION_EXPIRED" }],
    });

    const error = await captureRefused(refusing(422, body, headerId()));

    expect(error).toMatchObject({ name: "UNPROCESSABLE_ENTITY", debugId: headerId() });
    expect(error.hasIssue("AUTHORIZATION_EXPIRED")).toBe(true);
  });

  it("is kept at exactly the length the audit trail keeps, from the header or the body", async () => {
    const longest = "f".repeat(TRAIL_LIMIT);
    const named = JSON.stringify({ name: "UNPROCESSABLE_ENTITY", debug_id: longest });

    const fromHeader = await captureRefused(
      refusing(401, paypalFixtureText("api/api-401-invalid-token.json"), longest),
    );
    const fromBody = await captureRefused(refusing(422, named));

    expect(fromHeader.debugId).toBe(longest);
    expect(fromBody.debugId).toBe(longest);
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["a header longer than any id the audit trail keeps", "f".repeat(TRAIL_LIMIT + 1)],
  ])("is null when the body has none and there is %s", async (_case, header) => {
    const error = await captureRefused(
      refusing(401, paypalFixtureText("api/api-401-invalid-token.json"), header),
    );

    expect(error).toMatchObject({ status: 401, name: "invalid_token", debugId: null });
  });

  it("is null when the body's is longer than the audit trail keeps and there is no header", async () => {
    const body = JSON.stringify({
      name: "UNPROCESSABLE_ENTITY",
      debug_id: "b".repeat(TRAIL_LIMIT + 1),
    });

    const error = await captureRefused(refusing(422, body));

    expect(error).toMatchObject({ name: "UNPROCESSABLE_ENTITY", debugId: null });
  });
});

describe("the token cache when a token cannot be had (pinned against what the SDK's skills warn of)", () => {
  it("asks again after a token request PayPal failed: a failure is never kept", async () => {
    paypal.on(
      "POST /v1/oauth2/token",
      { status: 503, body: { name: "SERVICE_UNAVAILABLE", debug_id: "tok503" } },
      { status: 200, body: TOKEN },
    );
    paypal.on(`GET ${AUTHORIZATION_PATH}`, { status: 200, body: AUTHORIZATION });
    const paypalClient = client();

    await expect(
      paypalClient.get(AUTHORIZATION_PATH, { response: authorization }),
    ).rejects.toMatchObject({ status: 503, debugId: "tok503" });
    const answer = await paypalClient.get(AUTHORIZATION_PATH, { response: authorization });

    expect(answer.body).toEqual(AUTHORIZATION);
    expect(tokenCalls()).toHaveLength(2);
  });

  it("asks again after a token request that got no answer", async () => {
    let tokenRequests = 0;
    const { client: paypalClient, sent } = stubbed({
      "/v1/oauth2/token": () => {
        tokenRequests += 1;
        if (tokenRequests === 1) {
          throw new TypeError("fetch failed");
        }
        return Response.json(TOKEN);
      },
      [AUTHORIZATION_PATH]: () => Response.json(AUTHORIZATION),
    });

    await expect(
      paypalClient.get(AUTHORIZATION_PATH, { response: authorization }),
    ).rejects.toBeInstanceOf(PayPalTransportError);
    await paypalClient.get(AUTHORIZATION_PATH, { response: authorization });

    expect(sent).toEqual([
      "POST /v1/oauth2/token",
      "POST /v1/oauth2/token",
      `GET ${AUTHORIZATION_PATH}`,
    ]);
  });

  it("refuses a token that names no lifetime, and sends nothing with it", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: { ...TOKEN, expires_in: undefined } });
    paypal.on(`GET ${AUTHORIZATION_PATH}`, { status: 200, body: AUTHORIZATION });

    await expect(
      client().get(AUTHORIZATION_PATH, { response: authorization }),
    ).rejects.toBeInstanceOf(PayPalContractError);
    expect(paypal.requests.map((r) => r.path)).toEqual(["/v1/oauth2/token"]);
  });
});

describe("the client's waiting and asking again (pinned: its own timeout, no retry of its own)", () => {
  /**
   * An answer that comes after a delay, or fails as fetch does when the
   * request's signal aborts first.
   *
   * @param delayMs - How long the answer takes.
   * @param body - The JSON body.
   * @returns The route.
   */
  const after =
    (delayMs: number, body: unknown) =>
    (signal: AbortSignal): Promise<Response> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json(body)), delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason as Error);
        });
      });

  it("gives up on a request that outlasts its timeout, as no answer", async () => {
    const { client: paypalClient, sent } = stubbed(
      {
        "/v1/oauth2/token": () => Response.json(TOKEN),
        [AUTHORIZATION_PATH]: after(60_000, AUTHORIZATION),
      },
      50,
    );

    const error = await paypalClient
      .get(AUTHORIZATION_PATH, { response: authorization })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PayPalTransportError);
    expect((error as Error).cause).toMatchObject({ name: "TimeoutError" });
    expect(sent).toEqual(["POST /v1/oauth2/token", `GET ${AUTHORIZATION_PATH}`]);
  });

  it("bounds each request, not the call: a slow token and a slow answer together outlast it", async () => {
    const timeoutMs = 300;
    const { client: paypalClient } = stubbed(
      {
        "/v1/oauth2/token": after(200, TOKEN),
        [AUTHORIZATION_PATH]: after(200, AUTHORIZATION),
      },
      timeoutMs,
    );
    const startedAt = performance.now();

    const answer = await paypalClient.get(AUTHORIZATION_PATH, { response: authorization });

    expect(answer.body).toEqual(AUTHORIZATION);
    expect(performance.now() - startedAt).toBeGreaterThan(timeoutMs);
  });

  it.each(["GET", "POST"] as const)(
    "asks once when PayPal answers a %s with 503",
    async (method) => {
      const path =
        method === "GET" ? AUTHORIZATION_PATH : (`${AUTHORIZATION_PATH}/capture` as const);
      paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
      paypal.on(`${method} ${path}`, {
        status: 503,
        body: { name: "SERVICE_UNAVAILABLE", message: "Service Unavailable.", debug_id: "once503" },
      });

      const asked =
        method === "GET"
          ? client().get(path, { response: authorization })
          : client().post(path, {
              requestId: "8f0f8a3e-0000-8000-8000-000000000008",
              body: {},
              response: authorization,
            });

      await expect(asked).rejects.toMatchObject({ status: 503, name: "SERVICE_UNAVAILABLE" });
      expect(paypal.requests.filter((r) => r.path === path)).toHaveLength(1);
    },
  );

  it("asks once when a request gets no answer", async () => {
    const { client: paypalClient, sent } = stubbed({
      "/v1/oauth2/token": () => Response.json(TOKEN),
      [AUTHORIZATION_PATH]: () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(
      paypalClient.get(AUTHORIZATION_PATH, { response: authorization }),
    ).rejects.toBeInstanceOf(PayPalTransportError);
    expect(sent).toEqual(["POST /v1/oauth2/token", `GET ${AUTHORIZATION_PATH}`]);
  });
});

describe("an error body PayPal's documents do not describe (pinned)", () => {
  it("is read whole or not at all: one detail without an issue leaves only the status", async () => {
    paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
    paypal.on(`POST ${AUTHORIZATION_PATH}/capture`, {
      status: 422,
      body: {
        name: "UNPROCESSABLE_ENTITY",
        debug_id: "whole422",
        details: [{ issue: "AUTHORIZATION_EXPIRED" }, { description: "a detail with no issue" }],
      },
    });

    const error = (await client()
      .post(`${AUTHORIZATION_PATH}/capture`, {
        requestId: "8f0f8a3e-0000-8000-8000-000000000009",
        body: {},
        response: authorization,
      })
      .catch((caught: unknown) => caught)) as PayPalError;

    expect(error).toBeInstanceOf(PayPalError);
    expect(error).toMatchObject({ status: 422, name: "HTTP_422", debugId: null, details: [] });
    expect(error.hasIssue("AUTHORIZATION_EXPIRED")).toBe(false);
  });
});
