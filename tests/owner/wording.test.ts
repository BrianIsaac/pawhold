import { describe, expect, it } from "vitest";

import {
  approveLabel,
  askFirst,
  authoriseLabel,
  confirmedByPayPal,
  estimateHeading,
  estimateIntro,
  heldDone,
  linePrice,
  linkExpired,
  PAYPAL_ERROR,
  rangeLine,
  YOUR_VET,
} from "@/owner/wording";

describe("the owner's pages, in section 6's words", () => {
  it("asks the practice to send an expired or changed link again", () => {
    expect(linkExpired("Hollins Lane Veterinary Surgery")).toBe(
      "This link has expired. Ask Hollins Lane Veterinary Surgery to send it again.",
    );
  });

  it("asks the practice by no name when the link names none it can trust", () => {
    expect(linkExpired(null)).toBe(
      "This link has expired. Ask the practice that sent it to send it again.",
    );
  });

  it("heads the estimate with the patient and the practice", () => {
    expect(estimateHeading("Bramble", "Hollins Lane Veterinary Surgery")).toBe(
      "Bramble's estimate from Hollins Lane Veterinary Surgery",
    );
  });

  it("says what is held and why before anything else (D3)", () => {
    expect(estimateIntro(YOUR_VET, "Bramble", "£927.00")).toBe(
      "This is what your vet expects Bramble's treatment to cost. Nothing is charged now: PayPal holds up to £927.00, and you'll only pay for what's done.",
    );
  });

  it("gives the range in the vet's terms", () => {
    expect(rangeLine(YOUR_VET, "£731.00", "£927.00")).toBe(
      "Likely £731.00 to £927.00, depending on what your vet finds.",
    );
  });

  it("promises to ask before anything above the hold", () => {
    expect(askFirst(YOUR_VET, "£927.00")).toBe(
      "If your vet finds something that needs more, they'll ask you first. Nothing above £927.00 is charged without your yes.",
    );
  });

  it("prices a line as one figure, or as its range", () => {
    expect(linePrice("£72.00", "£72.00")).toBe("£72.00");
    expect(linePrice("£0.00", "£196.00")).toBe("£0.00 to £196.00");
  });
});

describe("authorising, in section 6's words", () => {
  it("labels the card button with the hold, and the update's with the increase", () => {
    expect(authoriseLabel("£927.00")).toBe("Authorise £927.00");
    expect(approveLabel("£155.00")).toBe("Approve £155.00");
  });

  it("says what is held, and on what, once authorised", () => {
    expect(heldDone("£927.00", "paypal")).toBe(
      "Done. £927.00 is held on your PayPal. You'll get the final bill at discharge.",
    );
    expect(heldDone("£927.00", "card")).toBe(
      "Done. £927.00 is held on your card. You'll get the final bill at discharge.",
    );
  });

  it("shows PayPal's confirmation with its time, and PayPal's error as drafted", () => {
    expect(confirmedByPayPal(new Date("2026-10-12T13:02:11.000Z"))).toBe(
      "Confirmed by PayPal 14:02:11",
    );
    expect(PAYPAL_ERROR).toBe(
      "PayPal couldn't complete that. Nothing has been charged. Try again, or use a card.",
    );
  });
});
