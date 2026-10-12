import { describe, expect, it } from "vitest";

import { fromPayPalValue, toPayPalValue } from "@/money/paypal-value";

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

describe("PayPal's amount value to pence", () => {
  it.each([
    ["0.00", 0],
    ["0.01", 1],
    ["1.00", 100],
    ["640.00", 64_000],
    ["78.05", 7_805],
    ["100", 10_000],
    ["2.5", 250],
  ])("reads %s as %i pence", (value, pence) => {
    expect(fromPayPalValue(value)).toBe(pence);
  });

  it("round-trips every value it writes", () => {
    for (const pence of [0, 1, 99, 100, 6_400, 11_500, 2_147_483_647]) {
      expect(fromPayPalValue(toPayPalValue(pence))).toBe(pence);
    }
  });

  it.each(["", "-1.00", "1.001", "1,000.00", "1e3", " 1.00", "1.", ".50", "21474836.48"])(
    "refuses %j",
    (value) => {
      expect(() => fromPayPalValue(value)).toThrow();
    },
  );
});
