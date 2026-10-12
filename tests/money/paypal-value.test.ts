import { describe, expect, it } from "vitest";

import { toPayPalValue } from "@/money/paypal-value";

describe("pence to PayPal's amount value", () => {
  it.each([
    [0, "0.00"],
    [1, "0.01"],
    [100, "1.00"],
    [64_000, "640.00"],
    [7_805, "78.05"],
  ])("writes %i pence as %s", (pence, value) => {
    expect(toPayPalValue(pence)).toBe(value);
  });

  it.each([-1, 1.5, Number.NaN])("refuses %s", (pence) => {
    expect(() => toPayPalValue(pence)).toThrow();
  });
});
