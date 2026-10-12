import { describe, expect, it } from "vitest";

import { estimateHeading, linkExpired } from "@/owner/wording";

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
});

describe("the estimate page's heading", () => {
  it("names the patient and the practice", () => {
    expect(estimateHeading("Biscuit", "Hollins Lane Veterinary Surgery")).toBe(
      "Biscuit's estimate from Hollins Lane Veterinary Surgery",
    );
  });
});
