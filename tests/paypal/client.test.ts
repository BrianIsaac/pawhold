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

describe("PayPal's debug id on an error (the sandbox sent `Paypal-Debug-Id` on every recorded answer)", () => {
  const recordedToken = recordedAnswer("P4", "POST", /^\/v1\/oauth2\/token$/);
  const HEADER_ID = recordedToken.debugId!;
  const withDebugId = { "content-type": "application/json", "paypal-debug-id": HEADER_ID };

  it("was sent on the token answer itself, whose body carries none", () => {
    expect(recordedToken.status).toBe(200);
    expect(HEADER_ID).toMatch(/^[0-9a-f]{10,}$/);
  });

  it("is kept from the header when the credentials are refused: the identity body has none", async () => {
    const { client: paypalClient } = stubbed({
      "/v1/oauth2/token": () =>
        new Response(paypalFixtureText("api/oauth-401-invalid-client.json"), {
          status: 401,
          headers: withDebugId,
        }),
    });

    const error = await paypalClient
      .get(AUTHORIZATION_PATH, { response: authorization })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PayPalError);
    expect(error).toMatchObject({ status: 401, name: "invalid_client", debugId: HEADER_ID });
  });

  it("is kept from the header when the token is refused on the call and again after the refresh", async () => {
    const { client: paypalClient, sent } = stubbed({
      "/v1/oauth2/token": () => Response.json(TOKEN),
      [AUTHORIZATION_PATH]: () =>
        new Response(paypalFixtureText("api/api-401-invalid-token.json"), {
          status: 401,
          headers: withDebugId,
        }),
    });

    const error = await paypalClient
      .get(AUTHORIZATION_PATH, { response: authorization })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 401, name: "invalid_token", debugId: HEADER_ID });
    expect(sent.filter((request) => request.endsWith(AUTHORIZATION_PATH))).toHaveLength(2);
  });

  it("is kept from the header on an answer that is not JSON, named by its status", async () => {
    const { client: paypalClient } = stubbed({
      "/v1/oauth2/token": () => Response.json(TOKEN),
      [`${AUTHORIZATION_PATH}/capture`]: () =>
        new Response("<html><body>Service Unavailable</body></html>", {
          status: 503,
          headers: { "content-type": "text/html", "paypal-debug-id": HEADER_ID },
        }),
    });

    const error = await paypalClient
      .post(`${AUTHORIZATION_PATH}/capture`, {
        requestId: "8f0f8a3e-0000-8000-8000-000000000006",
        body: {},
        response: authorization,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PayPalError);
    expect(error).toMatchObject({ status: 503, name: "HTTP_503", debugId: HEADER_ID, details: [] });
  });

  it("is the body's where PayPal gives both: negative testing's recorded refusal carries two", async () => {
    const refusal = recordedAnswer("P5A", "POST", /\/capture$/);
    const inBody = (refusal.responseBody as { debug_id: string }).debug_id;
    expect(refusal.debugId).not.toBe(inBody);
    const { client: paypalClient } = stubbed({
      "/v1/oauth2/token": () => Response.json(TOKEN),
      [`${AUTHORIZATION_PATH}/capture`]: () =>
        Response.json(refusal.responseBody, {
          status: refusal.status!,
          headers: { "paypal-debug-id": refusal.debugId! },
        }),
    });

    const error = await paypalClient
      .post(`${AUTHORIZATION_PATH}/capture`, {
        requestId: "8f0f8a3e-0000-8000-8000-000000000007",
        body: {},
        response: authorization,
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 422, debugId: inBody });
    expect((error as PayPalError).hasIssue("AUTHORIZATION_EXPIRED")).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["an empty header", "  "],
    ["a header longer than any id the audit trail keeps", "f".repeat(256)],
  ])("is null when the body has none and there is %s", async (_case, header) => {
    const { client: paypalClient } = stubbed({
      "/v1/oauth2/token": () =>
        new Response(paypalFixtureText("api/oauth-401-invalid-client.json"), {
          status: 401,
          headers: header === undefined ? {} : { "paypal-debug-id": header },
        }),
    });

    const error = await paypalClient
      .get(AUTHORIZATION_PATH, { response: authorization })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 401, name: "invalid_client", debugId: null });
  });
});
