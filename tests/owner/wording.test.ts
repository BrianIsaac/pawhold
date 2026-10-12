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
  capitalised,
  updateAdds,
  DONT_GO_AHEAD,
  PRACTICE_WILL_CALL,
  updateDeclined,
  linkReplaced,
} from "@/owner/wording";
import { updateHeading } from "@/agent/wording";

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

describe("an update, in section 6's words", () => {
  it("heads the update with the vet asking first", () => {
    expect(updateHeading(capitalised(YOUR_VET))).toBe(
      "Your vet found something and is asking before going ahead.",
    );
  });

  it("says what the update adds to the estimate", () => {
    expect(updateAdds("£155.00", "Bramble")).toBe("This adds £155.00 to Bramble's estimate.");
  });

  it("offers not to go ahead, and says what follows", () => {
    expect(DONT_GO_AHEAD).toBe("Don't go ahead");
    expect(PRACTICE_WILL_CALL).toBe("The practice will call you to talk it through.");
  });

  it("says what stays held once the owner said no, and that an old link was replaced", () => {
    expect(updateDeclined("£927.00")).toBe(
      "You said not to go ahead. The practice will call you to talk it through. The £927.00 already held stays as it is.",
    );
    expect(linkReplaced("Hollins Lane Veterinary Surgery")).toBe(
      "This estimate has been replaced by a newer one. Ask Hollins Lane Veterinary Surgery for its link.",
    );
  });
});
