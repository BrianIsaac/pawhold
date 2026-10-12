import { describe, expect, it } from "vitest";

import { formatMoney, formatPercent } from "@/money/format";

describe("money as the screens show it", () => {
  it("renders integer pence as pounds and pence", () => {
    expect(formatMoney({ pence: 77_300, currency: "GBP" })).toBe("£773.00");
    expect(formatMoney({ pence: 5, currency: "GBP" })).toBe("£0.05");
    expect(formatMoney({ pence: 114_700, currency: "GBP" })).toBe("£1,147.00");
  });

  it("names dollars on the USD branch (plan 3.6)", () => {
    expect(formatMoney({ pence: 50_000, currency: "USD" })).toBe("US$500.00");
  });

  it("signs a decrease", () => {
    expect(formatMoney({ pence: -2_000, currency: "GBP" })).toBe("-£20.00");
  });

  it("refuses money that is not whole pence", () => {
    expect(() => formatMoney({ pence: 1.5, currency: "GBP" })).toThrow();
  });
});

describe("a percentage from basis points", () => {
  it("is whole when it is whole, else to one place, never rounded up past what it is", () => {
    expect(formatPercent(2_000)).toBe("20");
    expect(formatPercent(1_990)).toBe("19.9");
    expect(formatPercent(1_999)).toBe("19.9");
    expect(formatPercent(2_373)).toBe("23.7");
    expect(formatPercent(5)).toBe("0");
  });
});
