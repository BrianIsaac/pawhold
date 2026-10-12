import { describe, expect, it } from "vitest";

import { assertNoSecrets, REDACTED, redact, SecretLeakError } from "../../probes/redact";

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
