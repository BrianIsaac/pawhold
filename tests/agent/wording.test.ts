import { describe, expect, it } from "vitest";

import {
  DRAFT_FAILED,
  fromYourNotes,
  leftOutUnsupported,
  noItemMatched,
  onlyIf,
  updateHeading,
  WHAT_THE_VET_WROTE,
} from "@/agent/wording";

describe("the agent's words on the screens, as plan section 6 drafts them (D11)", () => {
  it("writes a drafted line's span and its condition", () => {
    expect(fromYourNotes("pre-op bloods")).toBe('From your notes: "pre-op bloods"');
    expect(onlyIf("extractions are needed")).toBe("Only if: extractions are needed");
  });

  it("writes an unmatched span", () => {
    expect(noItemMatched("hydrotherapy")).toBe(
      'No price list item matched "hydrotherapy". Add an item by hand or leave it out.',
    );
  });

  it("writes the model's failure", () => {
    expect(DRAFT_FAILED).toBe(
      "The draft didn't work this time. Add items from your price list below.",
    );
  });

  it("writes a line left out as unsupported (this unit's wording, flagged)", () => {
    expect(leftOutUnsupported("dental x-rays")).toBe(
      'Left out: the draft quoted "dental x-rays", which is not in your notes.',
    );
  });

  it("writes the owner's update page heading and the vet's words' label", () => {
    expect(updateHeading("Dr Patel")).toBe(
      "Dr Patel found something and is asking before going ahead.",
    );
    expect(WHAT_THE_VET_WROTE).toBe("What the vet wrote");
  });

  it("has no em dash in any of them", () => {
    const all = [
      DRAFT_FAILED,
      fromYourNotes("x"),
      leftOutUnsupported("x"),
      noItemMatched("x"),
      onlyIf("x"),
      updateHeading("x"),
      WHAT_THE_VET_WROTE,
    ];
    for (const text of all) {
      expect(text).not.toContain("—");
    }
  });
});
