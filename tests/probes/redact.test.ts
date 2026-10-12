import { describe, expect, it } from "vitest";

import { secretsOf } from "../../probes/environment";
import { assertNoSecrets, REDACTED, redact, scrub, SecretLeakError } from "../../probes/redact";

describe("what the probes keep of PayPal's answers", () => {
  it("removes the payer's and the payee's personal details, keeping ids, statuses and the country", () => {
    const answer = {
      id: "7C971149UU297060S",
      status: "COMPLETED",
      payment_source: {
        paypal: {
          email_address: "buyer@example.com",
          account_id: "VX9Q54RPGFXVN",
          name: { given_name: "John", surname: "Doe" },
          address: { country_code: "GB", postal_code: "SW1A 1AA" },
        },
      },
      purchase_units: [{ payee: { email_address: "shop@example.com", merchant_id: "M1" } }],
    };

    expect(redact(answer)).toEqual({
      id: "7C971149UU297060S",
      status: "COMPLETED",
      payment_source: {
        paypal: {
          email_address: REDACTED,
          account_id: REDACTED,
          name: REDACTED,
          address: { country_code: "GB", postal_code: REDACTED },
        },
      },
      purchase_units: [{ payee: { email_address: REDACTED, merchant_id: REDACTED } }],
    });
  });

  it("keeps an error's name, which is a string, not a person's", () => {
    const error = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PREVIOUSLY_CAPTURED" }] };
    expect(redact(error)).toEqual(error);
  });

  it("refuses text holding a secret, whatever its case, without naming it", () => {
    const secrets = ["Buyer@Example.com", "s3cret-pass"];
    expect(() => assertNoSecrets("signed in as buyer@example.com", secrets, "a log")).toThrow(
      SecretLeakError,
    );
    expect(() => assertNoSecrets("password s3cret-pass", secrets, "a log")).toThrow(
      /^a log holds 1 secret value\(s\); not written$/,
    );
    expect(assertNoSecrets("order 7C971149UU297060S", secrets, "a log")).toBe(
      "order 7C971149UU297060S",
    );
  });
});

describe("the wider redaction rules", () => {
  it("removes a card holder's name, a billing address but its country, and a webhook id", () => {
    expect(
      redact({
        payment_source: { card: { name: "Jane Doe", last_digits: "3024", brand: "VISA" } },
        billing_address: { postal_code: "SW1A 1AA", country_code: "GB" },
        webhook_id: "8PT597110X687430LKGECATA",
      }),
    ).toEqual({
      payment_source: { card: { name: REDACTED, last_digits: "3024", brand: "VISA" } },
      billing_address: { postal_code: REDACTED, country_code: "GB" },
      webhook_id: REDACTED,
    });
  });

  it("refuses a secret in its JSON-escaped form", () => {
    expect(() => assertNoSecrets(JSON.stringify({ p: 'pa"ss' }), ['pa"ss'], "a recording")).toThrow(
      SecretLeakError,
    );
  });
});

describe("scrubbing text read off a page", () => {
  it("removes the secrets whatever their case, and any email address", () => {
    expect(
      scrub("Paid by Buyer@Example.com via sb-abc123@personal.example.com, pass S3cret", [
        "buyer@example.com",
        "s3cret",
      ]),
    ).toBe(`Paid by ${REDACTED} via ${REDACTED}, pass ${REDACTED}`);
  });

  it("treats a secret's regular-expression characters literally", () => {
    expect(scrub("a+b.c and axbyc", ["a+b.c"])).toBe(`${REDACTED} and axbyc`);
  });
});

describe("the probes' secrets", () => {
  it("guard the webhook id and the database URL whole and by its host and password", () => {
    const secrets = secretsOf({
      PAYPAL_CLIENT_ID: "cid",
      PAYPAL_CLIENT_SECRET: "csecret",
      PAYPAL_SANDBOX_BUSINESS_EMAIL: "biz@example.com",
      PAYPAL_SANDBOX_BUYER_EMAIL: "buyer@example.com",
      PAYPAL_SANDBOX_BUYER_PASSWORD: "pw",
      PAYPAL_WEBHOOK_ID: "WH123",
      P8_DATABASE_URL:
        "postgresql://pawhold_user:p%40ss@dpg-abc.frankfurt-postgres.render.com/pawhold",
    });

    expect(secrets).toEqual(
      expect.arrayContaining(["WH123", "dpg-abc.frankfurt-postgres.render.com", "p@ss"]),
    );
  });

  it("leave the database user alone: render.yaml names it, and as pawhold it is in every line", () => {
    const secrets = secretsOf({
      PAYPAL_CLIENT_ID: "cid",
      PAYPAL_CLIENT_SECRET: "csecret",
      PAYPAL_SANDBOX_BUSINESS_EMAIL: "biz@example.com",
      PAYPAL_SANDBOX_BUYER_EMAIL: "buyer@example.com",
      PAYPAL_SANDBOX_BUYER_PASSWORD: "pw",
      P8_DATABASE_URL: "postgresql://pawhold:s3cret@dpg-abc.frankfurt-postgres.render.com/pawhold",
    });

    expect(secrets).not.toContain("pawhold");
    expect(secrets).toContain("s3cret");
  });
});
