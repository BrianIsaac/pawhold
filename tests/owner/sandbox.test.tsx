import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { readSandboxBuyer, SANDBOX_TEST_CARD } from "@/owner/sandbox";

import { SandboxDetails } from "../../app/(owner)/e/[token]/sandbox";

const LOGIN = { email: "judge-buyer@example.com", password: "a-sandbox-password" };

describe("the owner's page in judge mode (plan 7.4: the sandbox login and the test card)", () => {
  it("shows the GB sandbox buyer's login and PayPal's GB test card, with no real money moved", () => {
    const html = renderToStaticMarkup(<SandboxDetails login={LOGIN} />);

    expect(html).toContain("Testing in PayPal&#x27;s sandbox");
    expect(html).toContain("No real money moves.");
    expect(html).toContain(LOGIN.email);
    expect(html).toContain(LOGIN.password);
    expect(html).toContain("4462 6030 4234 3024");
    expect(html).toContain("12/30");
    expect(html).toContain("123");
  });

  it("points to the README when the server was given no buyer login", () => {
    const html = renderToStaticMarkup(<SandboxDetails login={null} />);

    expect(html).toContain("In the Testing instructions of pawhold&#x27;s README");
    expect(html).toContain("4462 6030 4234 3024");
  });

  it("names its values for a screen reader as a list of terms", () => {
    const html = renderToStaticMarkup(<SandboxDetails login={LOGIN} />);

    expect(html).toMatch(/<aside [^>]*aria-labelledby="sandbox-heading"/);
    expect(html).toMatch(/<dt>PayPal email<\/dt><dd><code>judge-buyer@example.com<\/code><\/dd>/);
    expect(html).toMatch(/<dt>Card number<\/dt><dd><code>4462 6030 4234 3024<\/code><\/dd>/);
  });

  it("carries PayPal's GB 'Test Case 1' Visa, U0's decision 13", () => {
    expect(SANDBOX_TEST_CARD).toEqual({ number: "4462603042343024", expiry: "12/30", cvv: "123" });
  });

  it("reads the buyer login from the server's environment, and only a whole, well-formed one", () => {
    expect(
      readSandboxBuyer({
        PAYPAL_SANDBOX_BUYER_EMAIL: LOGIN.email,
        PAYPAL_SANDBOX_BUYER_PASSWORD: LOGIN.password,
      }),
    ).toEqual(LOGIN);
    expect(readSandboxBuyer({ PAYPAL_SANDBOX_BUYER_EMAIL: LOGIN.email })).toBeNull();
    expect(
      readSandboxBuyer({
        PAYPAL_SANDBOX_BUYER_EMAIL: "not an email",
        PAYPAL_SANDBOX_BUYER_PASSWORD: LOGIN.password,
      }),
    ).toBeNull();
    expect(readSandboxBuyer({})).toBeNull();
  });
});
