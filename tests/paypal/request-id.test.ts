import { describe, expect, it } from "vitest";

import { paypalRequestId } from "@/paypal/request-id";

const CASE = "6f1c1f55-8f39-4d5e-9d39-2b0c0e7a3a10";
const HOLD = "0c8f6f2e-4f5a-4b8e-9f1e-3d2a1b0c9e8d";
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("the PayPal-Request-Id helper (plan 3.2, rule 4)", () => {
  it("derives the same id from the same case, hold and step, so a retry never captures twice", () => {
    const first = paypalRequestId({ caseId: CASE, holdId: HOLD, step: "capture" });
    const again = paypalRequestId({ caseId: CASE, holdId: HOLD, step: "capture" });

    expect(first).toBe(again);
    expect(first).toMatch(UUID_V8);
  });

  it("derives different ids for different steps, holds and cases", () => {
    const ids = new Set([
      paypalRequestId({ caseId: CASE, holdId: HOLD, step: "capture" }),
      paypalRequestId({ caseId: CASE, holdId: HOLD, step: "void" }),
      paypalRequestId({ caseId: CASE, holdId: CASE, step: "capture" }),
      paypalRequestId({ caseId: HOLD, holdId: HOLD, step: "capture" }),
      paypalRequestId({ caseId: CASE, step: "order.create" }),
    ]);

    expect(ids.size).toBe(5);
  });

  it("refuses a step name that is not a plain lower-case word", () => {
    expect(() => paypalRequestId({ caseId: CASE, holdId: HOLD, step: "Capture now" })).toThrow();
  });
});
