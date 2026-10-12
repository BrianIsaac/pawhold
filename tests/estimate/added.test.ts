import { describe, expect, it } from "vitest";

import { linesAdded } from "@/estimate/added";

/** A line as the comparison reads it, with an id to tell copies apart. */
function line(
  id: string,
  code: string,
  quantityLow: number,
  quantityHigh: number,
  ownerWording: string | null = null,
) {
  return { id, code, quantityLow, quantityHigh, ownerWording, dependsOn: null };
}

describe("the lines an update added or changed (U11)", () => {
  it("is each line the version before had no twin of, never every line of a code it touched", () => {
    // Juno's update: a second lump removed and sent to the lab, on codes the
    // estimate already had once each.
    const before = [
      line("a1", "LAB-PRE", 1, 1),
      line("a2", "SURG-LUMP", 1, 1, "Removing the lump"),
      line("a3", "LAB-HIST", 1, 1, "Laboratory check of the lump"),
    ];
    const after = [
      line("b1", "LAB-PRE", 1, 1),
      line("b2", "SURG-LUMP", 1, 1, "Removing the lump"),
      line("b3", "LAB-HIST", 1, 1, "Laboratory check of the lump"),
      line("b4", "SURG-LUMP", 1, 1, "Removing the second lump"),
      line("b5", "LAB-HIST", 1, 1, "Laboratory check of the second lump"),
    ];

    expect(linesAdded(before, after).map((one) => one.id)).toEqual(["b4", "b5"]);
  });

  it("counts a line raised as added, and a twin left as it was as not", () => {
    const before = [line("a1", "DEN-EXT-SG", 0, 2), line("a2", "GA-DENT", 1, 1)];
    const after = [line("b1", "DEN-EXT-SG", 0, 4), line("b2", "GA-DENT", 1, 1)];

    expect(linesAdded(before, after).map((one) => one.id)).toEqual(["b1"]);
  });

  it("matches a line once only, so a second copy of a line is added", () => {
    const before = [line("a1", "MED-ANTIB-TAB", 1, 1)];
    const after = [line("b1", "MED-ANTIB-TAB", 1, 1), line("b2", "MED-ANTIB-TAB", 1, 1)];

    expect(linesAdded(before, after).map((one) => one.id)).toEqual(["b2"]);
  });
});
