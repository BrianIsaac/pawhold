import { describe, expect, it } from "vitest";

import { formatMoney, formatPence, formatPercent } from "@/money/format";

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

describe("an amount the owner is asked for, held for or paid", () => {
  it("shows integer pence as pounds and pence, as the screens do", () => {
    expect(formatPence(92_700, "GBP")).toBe("£927.00");
    expect(formatPence(115_900, "GBP")).toBe("£1,159.00");
    expect(formatPence(0, "GBP")).toBe("£0.00");
    expect(formatPence(5, "GBP")).toBe("£0.05");
    expect(formatPence(77_300, "GBP")).toBe(formatMoney({ pence: 77_300, currency: "GBP" }));
  });

  it("shows dollars on the forced branch's currency", () => {
    expect(formatPence(12_345, "USD")).toBe("US$123.45");
  });

  it("refuses an amount that is not whole, non-negative pence", () => {
    expect(() => formatPence(1.5, "GBP")).toThrow(RangeError);
    expect(() => formatPence(-1, "GBP")).toThrow(RangeError);
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

describe("a range of money (U11)", () => {
  it("names one figure when its ends are the same, and both otherwise", async () => {
    const { formatMoneyRange } = await import("@/money/format");

    expect(formatMoneyRange({ lowPence: 9_500, highPence: 9_500, currency: "GBP" })).toBe("£95.00");
    expect(formatMoneyRange({ lowPence: 73_100, highPence: 92_700, currency: "GBP" })).toBe(
      "£731.00 to £927.00",
    );
  });
});
