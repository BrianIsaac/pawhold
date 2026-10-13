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
  patientDrawn,
  askToSendAgain,
  LINK_EXPIRED,
  PAYPAL_ERROR,
  rangeLine,
  YOUR_VET,
  vetCalled,
  capitalised,
  updateAdds,
  DONT_GO_AHEAD,
  PRACTICE_WILL_CALL,
  updateDeclined,
  linkReplaced,
  receiptPaid,
  paidFromApprovals,
  RELEASE_TIMING,
  refundedNote,
  billQuantity,
} from "@/owner/wording";
import { updateHeading } from "@/agent/wording";

describe("the owner's pages, in section 6's words", () => {
  it("asks the practice to send an expired or changed link again", () => {
    expect(`${LINK_EXPIRED}. ${askToSendAgain("Hollins Lane Veterinary Surgery")}`).toBe(
      "This link has expired. Ask Hollins Lane Veterinary Surgery to send it again.",
    );
  });

  it("asks the practice by no name when the link names none it can trust", () => {
    expect(askToSendAgain(null)).toBe("Ask the practice that sent it to send it again.");
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

describe("the vet, as section 6's {vet name}", () => {
  it("is the case's vet by name, or the plain words for a case opened before vets were named", () => {
    expect(vetCalled("Rowan Hale")).toBe("Rowan Hale");
    expect(vetCalled(null)).toBe(YOUR_VET);
    expect(estimateIntro(vetCalled("Rowan Hale"), "Bramble", "£927.00")).toBe(
      "This is what Rowan Hale expects Bramble's treatment to cost. Nothing is charged now: PayPal holds up to £927.00, and you'll only pay for what's done.",
    );
    expect(updateHeading(capitalised(vetCalled("Rowan Hale")))).toBe(
      "Rowan Hale found something and is asking before going ahead.",
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

describe("the receipt, in section 6's words", () => {
  it("says what was paid and what was released", () => {
    expect(receiptPaid("£795.00", "Bramble", "£133.00")).toBe(
      "You paid £795.00 for Bramble's treatment. £133.00 of what was held has been released.",
    );
    expect(receiptPaid("£927.00", "Bramble", null)).toBe(
      "You paid £927.00 for Bramble's treatment.",
    );
  });

  it("says what each approval paid, in the order they were given", () => {
    expect(paidFromApprovals(["£675.00", "£120.00"])).toBe(
      "Paid from your first approval: £675.00. Paid from your second approval: £120.00.",
    );
    expect(paidFromApprovals(["£731.00"])).toBe("Paid from your approval: £731.00.");
  });

  it("says how many of a bill line were done", () => {
    expect(billQuantity(3, "£98.00")).toBe("3 at £98.00 each");
  });

  it("keeps the release's timing general, and names a refund", () => {
    expect(RELEASE_TIMING).toBe(
      "Released holds can take a few days to disappear from your statement.",
    );
    expect(refundedNote("£795.00", "£25.00")).toBe(
      "That is £795.00 charged at discharge, less £25.00 refunded to you.",
    );
  });
});

describe("the owner's words the pixel pass changed (U11)", () => {
  it("gives an estimate with no range one figure", async () => {
    const { rangeLine } = await import("@/owner/wording");

    expect(rangeLine("Rowan Hale", "£95.00", "£95.00")).toBe(
      "Likely £95.00, depending on what Rowan Hale finds.",
    );
  });

  it("says an approval nothing was taken from was released, never paid from at £0.00", async () => {
    const { paidFromApprovals } = await import("@/owner/wording");

    expect(paidFromApprovals(["£482.00", null])).toBe(
      "Paid from your first approval: £482.00. Nothing was taken from your second approval: it was released.",
    );
    expect(paidFromApprovals(["£927.00", "£130.00"])).toBe(
      "Paid from your first approval: £927.00. Paid from your second approval: £130.00.",
    );
  });
});

describe("the drawings' words (U18)", () => {
  it("names the drawing as U17 names the animal", () => {
    expect(patientDrawn("Otis", "dog")).toBe("A line drawing of Otis, a dog, sitting");
    expect(patientDrawn("Luna", "cat")).toBe("A line drawing of Luna, a cat, sitting");
    expect(patientDrawn("Otis", "dog", true)).toBe(
      "A line drawing of Otis, a dog, sitting happily",
    );
  });

  it("says a paw print is drawn for another animal, content or not", () => {
    expect(patientDrawn("Moss", "other")).toBe(
      "A line drawing of a paw print, for Moss, another animal",
    );
    expect(patientDrawn("Moss", "other", true)).toBe(patientDrawn("Moss", "other"));
  });
});
