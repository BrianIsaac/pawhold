import { describe, expect, it } from "vitest";

import { openingLine } from "../../app/(practice)/day/opening";

describe("where the day's grid opens (U11)", () => {
  it("keeps the lead columns before the line it brings into view", () => {
    expect(openingLine(20, [{ start: 20, end: 26 }])).toBe(18);
  });

  it("moves back to the start of a booking the view would open cut, and of one that cuts that", () => {
    expect(
      openingLine(28, [
        { start: 23, end: 27 },
        { start: 20, end: 24 },
        { start: 28, end: 34 },
      ]),
    ).toBe(20);
  });

  it("leaves room for the first hour's label: never opens on the last ten minutes of an hour", () => {
    expect(openingLine(13, [])).toBe(10);
    expect(openingLine(14, [])).toBe(10);
    expect(openingLine(15, [])).toBe(13);
    expect(openingLine(25, [{ start: 25, end: 31 }])).toBe(22);
  });

  it("keeps its place when making room for the label would cut a booking, however far back that one starts", () => {
    expect(
      openingLine(25, [
        { start: 2, end: 23 },
        { start: 25, end: 31 },
      ]),
    ).toBe(23);
  });

  it("never opens before the grid's first line", () => {
    expect(openingLine(2, [])).toBe(1);
  });
});
