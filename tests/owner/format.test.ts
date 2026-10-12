import { describe, expect, it } from "vitest";

import { formatMoney, formatPence } from "@/money/format";

describe("money as the screens show it", () => {
  it("shows integer pence as pounds and pence", () => {
    expect(formatPence(92_700, "GBP")).toBe("£927.00");
    expect(formatPence(115_900, "GBP")).toBe("£1,159.00");
    expect(formatPence(0, "GBP")).toBe("£0.00");
    expect(formatPence(5, "GBP")).toBe("£0.05");
    expect(formatMoney({ pence: 77_300, currency: "GBP" })).toBe("£773.00");
  });

  it("shows dollars on the forced branch's currency", () => {
    expect(formatPence(12_345, "USD")).toBe("US$123.45");
  });

  it("refuses an amount that is not whole pence", () => {
    expect(() => formatPence(1.5, "GBP")).toThrow(RangeError);
    expect(() => formatPence(-1, "GBP")).toThrow(RangeError);
  });
});
