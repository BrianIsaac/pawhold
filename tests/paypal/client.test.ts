import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createPayPalClient, PayPalContractError, PayPalError } from "@/paypal/client";

import { paypalFixture } from "../support/fixtures";
import { startMockPayPal } from "../support/mock-paypal";

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
