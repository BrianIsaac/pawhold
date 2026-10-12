import { describe, expect, it } from "vitest";

import {
  askToApprove,
  estimateTotal,
  triggerSentence,
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

  const check = {
    originalPence: 92_700,
    revisedPence: 114_700,
    increasePence: 22_000,
    increaseBasisPoints: 2_373,
    thresholdPence: 50_000,
    triggerPence: 18_540,
    met: true,
  };

  it("gives section 6's trigger sentence when the original is what is held", () => {
    expect(
      triggerSentence({
        increasePence: 22_000,
        heldPence: 92_700,
        check,
        currency: GBP,
        ownerFirstName: "Nadia",
      }),
    ).toBe(
      "This adds £220.00, 23.7% over the held estimate. The CMA's Order asks for an updated written estimate at 20% or £500.00, whichever is lower: this one meets it. pawhold asks the owner either way, because nothing over the hold is charged without their yes.",
    );
  });

  it("names both bases once an update was approved before", () => {
    expect(
      triggerSentence({
        increasePence: 5_000,
        heldPence: 109_700,
        check: { ...check, revisedPence: 114_700 },
        currency: GBP,
        ownerFirstName: "Nadia",
      }),
    ).toBe(
      "This adds £50.00 to what is held; with the updates approved before it, the estimate is 23.7% over the original written estimate of £927.00. The CMA's Order asks for an updated written estimate at 20% or £500.00, whichever is lower: this one meets it. pawhold asks the owner either way, because nothing over the hold is charged without their yes.",
    );
  });

  it("says when an update adds nothing to ask for", () => {
    expect(
      triggerSentence({
        increasePence: 0,
        heldPence: 92_700,
        check,
        currency: GBP,
        ownerFirstName: "Nadia",
      }),
    ).toBe("This update adds nothing over what is held, so there is nothing to ask Nadia for.");
  });

  it("labels the update's send with the increase", () => {
    expect(askToApprove("Nadia", 13_000, GBP)).toBe("Ask Nadia to approve £130.00");
  });
});
