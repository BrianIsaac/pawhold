import { describe, expect, it } from "vitest";

import { createPayPalClient } from "@/paypal/client";
import {
  approvalUrl,
  authorizeOrder,
  createAuthorizeOrder,
  onlyAuthorization,
  order,
  OrderRequestError,
  paymentKindOf,
} from "@/paypal/orders";

import { paypalFixture } from "../support/fixtures";
import { startMockPayPal } from "../support/mock-paypal";
import { recordedAnswer, recordedAnswers } from "../support/recorded";

const paypal = startMockPayPal();
const TOKEN = paypalFixture("api/oauth-token.json");
const REQUEST_ID = "0a6f3c42-55e1-8d2b-9c1e-6f1d2a3b4c5d";
const GBP = (pence: number) => ({ pence, currency: "GBP" as const });

/**
 * A client pointed at the mock PayPal, which answers an order create with
 * P1's recorded answer.
 *
 * @returns The client.
 */
function client() {
  paypal.on("POST /v1/oauth2/token", { status: 200, body: TOKEN });
  paypal.on("POST /v2/checkout/orders", {
    status: 200,
    body: recordedAnswer("P1", "POST", /^\/v2\/checkout\/orders$/).responseBody,
  });
  return createPayPalClient({
    clientId: "FAKE-CLIENT-ID",
    clientSecret: "FAKE-CLIENT-SECRET",
    environment: "sandbox",
    baseUrl: paypal.baseUrl(),
  });
}

/**
 * The body of the order create the mock received.
 *
 * @returns The parsed body.
 */
function sentOrder(): Record<string, unknown> {
  const sent = paypal.requests.find((r) => r.path === "/v2/checkout/orders")!;
  expect(sent.headers["paypal-request-id"]).toBe(REQUEST_ID);
  expect(sent.headers.prefer).toBe("return=representation");
  return JSON.parse(sent.body) as Record<string, unknown>;
}

describe("the Orders v2 answers, as the sandbox gave them (U0's recordings)", () => {
  it("reads every recorded order create and authorise answer", () => {
    let read = 0;
    for (const probe of ["SMOKE", "P1", "P2", "P3", "P4", "P5A", "P6", "P7", "P9"]) {
      for (const exchange of recordedAnswers(
        probe,
        "POST",
        /^\/v2\/checkout\/orders(\/[^/]+\/authorize)?$/,
      )) {
        order.parse(exchange.responseBody);
        read += 1;
      }
    }
    expect(read).toBeGreaterThan(20);
  });

  it("finds the authorisation and the payment kind of a wallet hold and a card hold", () => {
    const wallet = order.parse(recordedAnswer("P1", "POST", /\/authorize$/).responseBody);
    const card = order.parse(recordedAnswer("P6", "POST", /\/authorize$/).responseBody);

    expect(wallet.status).toBe("COMPLETED");
    expect(onlyAuthorization(wallet).status).toBe("CREATED");
    expect(paymentKindOf(wallet)).toBe("paypal");
    expect(paymentKindOf(card)).toBe("card");
  });

  it("gives the payer-action link of an order made for PayPal's checkout", () => {
    const created = order.parse(
      recordedAnswer("P1", "POST", /^\/v2\/checkout\/orders$/).responseBody,
    );

    expect(created.status).toBe("PAYER_ACTION_REQUIRED");
    expect(approvalUrl(created)).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
  });
});

describe("an order to authorise", () => {
  it("is the probes' order when no lines are given: no breakdown, no items", async () => {
    await createAuthorizeOrder(client(), {
      amount: GBP(10_000),
      referenceId: "probe-a",
      customId: "pawhold-probe-a",
      description: "pawhold sandbox probe",
      requestId: REQUEST_ID,
    });

    expect(sentOrder()).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "probe-a",
          custom_id: "pawhold-probe-a",
          description: "pawhold sandbox probe",
          amount: { currency_code: "GBP", value: "100.00" },
        },
      ],
    });
  });

  it("mirrors the estimate's lines with their total, less what is already held (plan 3.3)", async () => {
    await createAuthorizeOrder(client(), {
      amount: GBP(23_000),
      referenceId: "hold",
      customId: "case/version",
      description: "Biscuit's estimate",
      requestId: REQUEST_ID,
      items: [
        { name: "General anaesthetic", sku: "GA-DENT", quantity: 1, unitAmount: GBP(32_000) },
        { name: "Tooth extraction", sku: "DEN-EXT", quantity: 2, unitAmount: GBP(9_800) },
        { name: "Dental radiographs", sku: "XR-DENT", quantity: 1, unitAmount: GBP(12_000) },
      ],
      discount: GBP(40_600),
      experience: {
        brandName: "Hollins Lane",
        locale: "en-GB",
        returnUrl: "https://example.com/return",
        cancelUrl: "https://example.com/cancel",
      },
    });

    const body = sentOrder() as {
      purchase_units: { amount: unknown; items: unknown }[];
      payment_source: unknown;
    };
    expect(body.purchase_units[0]!.amount).toEqual({
      currency_code: "GBP",
      value: "230.00",
      breakdown: {
        item_total: { currency_code: "GBP", value: "636.00" },
        discount: { currency_code: "GBP", value: "406.00" },
      },
    });
    expect(body.purchase_units[0]!.items).toEqual([
      {
        name: "General anaesthetic",
        sku: "GA-DENT",
        quantity: "1",
        unit_amount: { currency_code: "GBP", value: "320.00" },
      },
      {
        name: "Tooth extraction",
        sku: "DEN-EXT",
        quantity: "2",
        unit_amount: { currency_code: "GBP", value: "98.00" },
      },
      {
        name: "Dental radiographs",
        sku: "XR-DENT",
        quantity: "1",
        unit_amount: { currency_code: "GBP", value: "120.00" },
      },
    ]);
    expect(body.payment_source).toEqual({
      paypal: {
        experience_context: {
          brand_name: "Hollins Lane",
          locale: "en-GB",
          shipping_preference: "NO_SHIPPING",
          user_action: "CONTINUE",
          return_url: "https://example.com/return",
          cancel_url: "https://example.com/cancel",
        },
      },
    });
  });

  it("asks no shipping in the JS SDK's window, where there is no return URL (U6)", async () => {
    await createAuthorizeOrder(client(), {
      amount: GBP(92_700),
      referenceId: "hold",
      customId: "case/version",
      description: "Bramble's estimate",
      requestId: REQUEST_ID,
      experience: { brandName: "Hollins Lane", locale: "en-GB" },
    });

    expect((sentOrder() as { payment_source: unknown }).payment_source).toEqual({
      paypal: {
        experience_context: {
          brand_name: "Hollins Lane",
          locale: "en-GB",
          shipping_preference: "NO_SHIPPING",
          user_action: "CONTINUE",
        },
      },
    });
  });

  it("keeps an item's name to PayPal's 127 characters", async () => {
    await createAuthorizeOrder(client(), {
      amount: GBP(100),
      referenceId: "hold",
      customId: "case/version",
      description: "estimate",
      requestId: REQUEST_ID,
      items: [{ name: "x".repeat(200), sku: "LONG", quantity: 1, unitAmount: GBP(100) }],
    });

    const body = sentOrder() as { purchase_units: { items: { name: string }[] }[] };
    expect(body.purchase_units[0]!.items[0]!.name).toHaveLength(127);
    expect(body.purchase_units[0]!.items[0]!.name.endsWith("...")).toBe(true);
  });

  it("is refused before it is sent when the lines less the discount are not the amount", async () => {
    const refused = createAuthorizeOrder(client(), {
      amount: GBP(23_001),
      referenceId: "hold",
      customId: "case/version",
      description: "estimate",
      requestId: REQUEST_ID,
      items: [{ name: "Consultation", sku: "CON-STD", quantity: 1, unitAmount: GBP(23_000) }],
    });

    await expect(refused).rejects.toBeInstanceOf(OrderRequestError);
    expect(paypal.requests.some((r) => r.path === "/v2/checkout/orders")).toBe(false);
  });

  it("authorises with an empty body and its own request id", async () => {
    paypal.on("POST /v2/checkout/orders/4SJ22740VK065702B/authorize", {
      status: 201,
      body: recordedAnswer("P2", "POST", /\/authorize$/).responseBody,
    });

    const authorised = await authorizeOrder(client(), "4SJ22740VK065702B", REQUEST_ID);

    expect(onlyAuthorization(authorised).id).toBe("86E59591GJ353572T");
    const sent = paypal.requests.find((r) => r.path.endsWith("/authorize"))!;
    expect(sent.headers["paypal-request-id"]).toBe(REQUEST_ID);
    expect(JSON.parse(sent.body)).toEqual({});
  });
});
