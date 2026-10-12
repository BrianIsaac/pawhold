import { describe, expect, it } from "vitest";

import {
  estimateTotal,
  lineQuantity,
  linePrice,
  sendTo,
  sentConfirmation,
} from "@/practice/wording";

const GBP = "GBP" as const;

describe("the case page's words (section 6, D11)", () => {
  it("gives the total and the hold", () => {
    expect(estimateTotal({ lowPence: 57_700, highPence: 77_300 }, GBP)).toBe(
      "Estimate £577.00 to £773.00. The hold will be £773.00.",
    );
  });

  it("names the owner on the send and its confirmation", () => {
    expect(sendTo("Nadia")).toBe("Send to Nadia");
    expect(sentConfirmation("Nadia")).toBe(
      "Sent. Nadia can authorise the hold from the link on their phone.",
    );
  });

  it("gives a line's quantity or range against its unit price", () => {
    const line = { quantityLow: 0, quantityHigh: 2, unitPricePence: 9_800, unit: "tooth" };
    expect(lineQuantity(line, GBP)).toBe("0 to 2 at £98.00 per tooth");
    expect(lineQuantity({ ...line, quantityLow: 2 }, GBP)).toBe("2 at £98.00 per tooth");
  });

  it("gives a line's price, as a range when it has one", () => {
    expect(linePrice({ lowPence: 0, highPence: 19_600 }, GBP)).toBe("£0.00 to £196.00");
    expect(linePrice({ lowPence: 32_000, highPence: 32_000 }, GBP)).toBe("£320.00");
  });
});
