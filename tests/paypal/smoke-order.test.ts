import { describe, expect, it } from "vitest";

import { createPayPalClient } from "@/paypal/client";
import { createSmokeOrder } from "@/paypal/smoke-order";

import { paypalFixture } from "../support/fixtures";
import { startMockPayPal } from "../support/mock-paypal";

const paypal = startMockPayPal();

describe("the deployment's sandbox order check", () => {
  it("creates a £1.00 order to authorise, with a PayPal-Request-Id, and reports its id", async () => {
    paypal.on("POST /v1/oauth2/token", {
      status: 200,
      body: paypalFixture("api/oauth-token.json"),
    });
    paypal.on("POST /v2/checkout/orders", {
      status: 201,
      body: { id: "5O190127TN364715T", status: "CREATED", links: [] },
    });
    const client = createPayPalClient({
      clientId: "FAKE-CLIENT-ID",
      clientSecret: "FAKE-CLIENT-SECRET-NOT-REAL",
      environment: "sandbox",
      baseUrl: paypal.baseUrl(),
    });

    const order = await createSmokeOrder(client, "GBP");

    expect(order).toEqual({ id: "5O190127TN364715T", status: "CREATED" });
    const sent = paypal.requests.find((r) => r.path === "/v2/checkout/orders")!;
    expect(sent.headers["paypal-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(sent.body)).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "pawhold-deployment-check",
          description: "pawhold deployment check (sandbox)",
          amount: { currency_code: "GBP", value: "1.00" },
        },
      ],
    });
  });
});
