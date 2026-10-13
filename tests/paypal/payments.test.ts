import { describe, expect, it } from "vitest";

import { createPayPalClient, PayPalError } from "@/paypal/client";
import {
  authorization,
  capture,
  captureAuthorization,
  moneyFromPayPal,
  parsePayPalTime,
  pence,
  reauthorizeAuthorization,
  refund,
  refundCapture,
  voidAuthorization,
} from "@/paypal/payments";

import { paypalFixture } from "../support/fixtures";
import { startMockPayPal } from "../support/mock-paypal";
import { recordedAnswer, recordedAnswers } from "../support/recorded";

const paypal = startMockPayPal();
const TOKEN = paypalFixture("api/oauth-token.json");
const REQUEST_ID = "0a6f3c42-55e1-8d2b-9c1e-6f1d2a3b4c5d";

/**
 * A client pointed at the mock PayPal.
 *
 * @returns The client.
 */
function client() {
  paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
  return createPayPalClient({
    clientId: "FAKE-CLIENT-ID",
    clientSecret: "FAKE-CLIENT-SECRET",
    environment: "sandbox",
    baseUrl: paypal.baseUrl(),
  });
}

describe("the Payments v2 answers, as the sandbox gave them (U0's recordings)", () => {
  it("reads every recorded authorisation, capture and void answer", () => {
    const probes = ["SMOKE", "P1", "P2", "P3", "P4", "P5A", "P6", "P7", "P9"];
    let read = 0;
    for (const probe of probes) {
      for (const exchange of recordedAnswers(
        probe,
        "GET",
        /^\/v2\/payments\/authorizations\/[^/]+$/,
      )) {
        authorization.parse(exchange.responseBody);
        read += 1;
      }
      for (const exchange of recordedAnswers(probe, "POST", /\/capture$/)) {
        if (exchange.status === 201) {
          capture.parse(exchange.responseBody);
          read += 1;
        }
      }
      for (const exchange of recordedAnswers(probe, "POST", /\/void$/)) {
        if (exchange.status === 200) {
          authorization.parse(exchange.responseBody);
          read += 1;
        }
      }
    }
    expect(read).toBeGreaterThan(30);
  });

  it("reads P2's capture of £64.00 of £100.00 into pence, with PayPal's fee", () => {
    const answer = capture.parse(recordedAnswer("P2", "POST", /\/capture$/).responseBody);

    expect(answer.status).toBe("COMPLETED");
    expect(answer.final_capture).toBe(true);
    expect(moneyFromPayPal(answer.amount!)).toEqual({ pence: 6_400, currency: "GBP" });
    expect(pence(answer.seller_receivable_breakdown?.paypal_fee)).toBe(238);
    expect(pence(answer.seller_receivable_breakdown?.net_amount)).toBe(6_162);
  });

  it("parses a void's local-offset time as the same instant as a Z time (U0: parse, never compare strings)", () => {
    const voided = authorization.parse(recordedAnswer("P4", "POST", /\/void$/).responseBody);

    expect(voided.status).toBe("VOIDED");
    expect(voided.update_time).toMatch(/[+-]\d\d:\d\d$/);
    expect(parsePayPalTime("2026-10-12T04:28:53-07:00").toISOString()).toBe(
      "2026-10-12T11:28:53.000Z",
    );
    expect(() => parsePayPalTime("12 October 2026")).toThrow();
  });

  it("reads the documented reauthorise answer: a new authorisation id, CREATED, no amount", () => {
    const answer = authorization.parse(paypalFixture("api/reauthorize-201.json"));

    expect(answer.id).toBe("8AA831015G517922L");
    expect(answer.status).toBe("CREATED");
    expect(answer.amount).toBeUndefined();
  });

  it("reads the documented refund answer", () => {
    const answer = refund.parse(paypalFixture("api/refund-201.json"));

    expect(answer.status).toBe("COMPLETED");
    expect(pence(answer.amount)).toBe(1_099);
  });
});

describe("the Payments v2 answers read more strictly than PayPal's own SDK reads them (pinned)", () => {
  const recorded = recordedAnswer("P2", "GET", /^\/v2\/payments\/authorizations\/[^/]+$/)
    .responseBody as Record<string, unknown>;

  it.each([
    ["an authorisation", authorization],
    ["a capture", capture],
    ["a refund", refund],
  ])("refuses %s in a status the published schema does not list", (_what, schema) => {
    expect(schema.safeParse({ id: "91T13242G72341823", status: "CREATED_LATER" }).success).toBe(
      false,
    );
  });

  it.each(["status_details", "amount", "expiration_time", "links"])(
    "refuses an explicit null for %s, which may be absent",
    (field) => {
      expect(authorization.safeParse(recorded).success).toBe(true);
      expect(authorization.safeParse({ ...recorded, [field]: null }).success).toBe(false);
    },
  );

  it("keeps the fields it does not name, as the sandbox sent them", () => {
    const read = authorization.parse(recorded) as Record<string, unknown>;

    expect(recorded.seller_protection).toBeDefined();
    expect(read.seller_protection).toEqual(recorded.seller_protection);
    expect(read.supplementary_data).toEqual(recorded.supplementary_data);
  });
});

describe("the Payments v2 requests", () => {
  it("captures with its request id, the representation asked for and the amount in PayPal's value", async () => {
    paypal.on("POST /v2/payments/authorizations/86E59591GJ353572T/capture", {
      status: 201,
      body: recordedAnswer("P2", "POST", /\/capture$/).responseBody,
    });

    await captureAuthorization(client(), "86E59591GJ353572T", {
      amount: { pence: 6_400, currency: "GBP" },
      finalCapture: true,
      requestId: REQUEST_ID,
    });

    const sent = paypal.requests.find((r) => r.path.endsWith("/capture"))!;
    expect(sent.headers["paypal-request-id"]).toBe(REQUEST_ID);
    expect(sent.headers.prefer).toBe("return=representation");
    expect(JSON.parse(sent.body)).toEqual({
      final_capture: true,
      amount: { currency_code: "GBP", value: "64.00" },
    });
  });

  it("sends negative testing's mock header through on a capture", async () => {
    paypal.on("POST /v2/payments/authorizations/AUTH1/capture", {
      status: 422,
      body: recordedAnswer("P5A", "POST", /\/capture$/).responseBody,
    });

    const refused = await captureAuthorization(client(), "AUTH1", {
      finalCapture: true,
      requestId: REQUEST_ID,
      headers: { "paypal-mock-response": '{"mock_application_codes":"AUTHORIZATION_EXPIRED"}' },
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PayPalError);
    expect((refused as PayPalError).hasIssue("AUTHORIZATION_EXPIRED")).toBe(true);
    const sent = paypal.requests.find((r) => r.path.endsWith("/capture"))!;
    expect(sent.headers["paypal-mock-response"]).toContain("AUTHORIZATION_EXPIRED");
  });

  it("voids with no body and reads the representation back", async () => {
    paypal.on("POST /v2/payments/authorizations/AUTH2/void", {
      status: 200,
      body: recordedAnswer("P4", "POST", /\/void$/).responseBody,
    });

    const voided = await voidAuthorization(client(), "AUTH2", REQUEST_ID);

    expect(voided?.status).toBe("VOIDED");
    expect(paypal.requests.find((r) => r.path.endsWith("/void"))!.body).toBe("");
  });

  it("reauthorises for the amount given and answers with the new authorisation", async () => {
    paypal.on("POST /v2/payments/authorizations/AUTH3/reauthorize", {
      status: 201,
      body: paypalFixture("api/reauthorize-201.json"),
    });

    const renewed = await reauthorizeAuthorization(client(), "AUTH3", REQUEST_ID, {
      pence: 77_300,
      currency: "GBP",
    });

    expect(renewed.id).toBe("8AA831015G517922L");
    const sent = paypal.requests.find((r) => r.path.endsWith("/reauthorize"))!;
    expect(JSON.parse(sent.body)).toEqual({ amount: { currency_code: "GBP", value: "773.00" } });
  });

  it("refunds a part with its amount, the whole with an empty body", async () => {
    paypal.on("POST /v2/payments/captures/CAP1/refund", {
      status: 201,
      body: paypalFixture("api/refund-201.json"),
    });

    await refundCapture(client(), "CAP1", REQUEST_ID, { pence: 1_099, currency: "GBP" });
    await refundCapture(client(), "CAP1", REQUEST_ID);

    const sent = paypal.requests.filter((r) => r.path.endsWith("/refund"));
    expect(JSON.parse(sent[0]!.body)).toEqual({ amount: { currency_code: "GBP", value: "10.99" } });
    expect(JSON.parse(sent[1]!.body)).toEqual({});
  });
});
