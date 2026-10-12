import { describe, expect, it } from "vitest";

import { approvalFailure } from "../../probes/buyer";

describe("a failed buyer approval (U0, U10's review)", () => {
  it("says where it failed and keeps the cause without the login", () => {
    const secrets = ["sb-standin4buyer@personal.example.com", "Xx0@{*Yy"];
    const raw = new Error(
      'locator.fill: Timeout 60000ms exceeded.\nCall log:\n  - fill("Xx0@{*Yy")\n  - fill("sb-standin4buyer@personal.example.com")',
    );

    const failure = approvalFailure("https://www.sandbox.paypal.com/signin", raw, secrets);

    expect(failure.message).toBe("buyer approval failed at https://www.sandbox.paypal.com/signin");
    expect(failure.cause).toBeInstanceOf(Error);
    const cause = (failure.cause as Error).message;
    expect(cause).toContain("locator.fill: Timeout 60000ms exceeded.");
    expect(cause).not.toContain("Xx0@{*Yy");
    expect(cause).not.toContain("sb-standin4buyer");
    expect((failure.cause as Error).stack).not.toContain("Xx0@{*Yy");
  });

  it("scrubs a cause that was not an Error", () => {
    const failure = approvalFailure("a closed window", "lost Xx0@{*Yy", ["Xx0@{*Yy"]);

    expect((failure.cause as Error).message).not.toContain("Xx0@{*Yy");
  });
});
