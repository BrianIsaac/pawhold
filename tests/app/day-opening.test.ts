import { describe, expect, it } from "vitest";

import { openingLine } from "../../app/(practice)/day/opening";

describe("where the day's grid opens (U11)", () => {
  it("keeps the lead columns before the line it brings into view", () => {
    expect(openingLine(20, [{ start: 20, end: 26 }])).toBe(18);
  });

  it("moves back to the start of a booking the view would open cut, and of one that cuts that", () => {
    expect(
      openingLine(20, [
        { start: 15, end: 19 },
        { start: 12, end: 16 },
        { start: 20, end: 26 },
      ]),
    ).toBe(12);
  });

  it("never opens before the grid's first line", () => {
    expect(openingLine(2, [])).toBe(1);
  });
});
