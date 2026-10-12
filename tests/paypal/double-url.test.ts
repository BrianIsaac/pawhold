import { describe, expect, it } from "vitest";

import { paypalEnvironment } from "@/env";

const CREDENTIALS = {
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "client",
  PAYPAL_CLIENT_SECRET: "secret",
};

describe("the browser suite's PayPal double URL", () => {
  it("is optional, and taken only on the loopback address over plain HTTP", () => {
    expect(paypalEnvironment.parse(CREDENTIALS).PAYPAL_DOUBLE_URL).toBeUndefined();
    expect(
      paypalEnvironment.parse({ ...CREDENTIALS, PAYPAL_DOUBLE_URL: "http://127.0.0.1:41234" })
        .PAYPAL_DOUBLE_URL,
    ).toBe("http://127.0.0.1:41234");
  });

  it("refuses any other host, so money calls can never be sent anywhere but PayPal or the double", () => {
    for (const url of [
      "https://api-m.sandbox.paypal.com",
      "http://example.com:41234",
      "http://127.0.0.1.example.com",
      "https://127.0.0.1:41234",
      "http://10.0.0.1:41234",
    ]) {
      expect(paypalEnvironment.safeParse({ ...CREDENTIALS, PAYPAL_DOUBLE_URL: url }).success).toBe(
        false,
      );
    }
  });
});
