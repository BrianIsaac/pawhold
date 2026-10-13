import { describe, expect, it } from "vitest";

import { openingLine, reachableLine, takeOverScroll } from "../../app/(practice)/day/opening";

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

describe("where the grid opens when the day ends before the view can open where it would (U16)", () => {
  it("opens where it would when the scroller reaches that far", () => {
    expect(reachableLine(100, 120.5, [])).toBe(100);
    expect(reachableLine(120, 120, [])).toBe(120);
  });

  it("opens at the last whole line the scroller reaches, never part way into a column", () => {
    expect(reachableLine(130, 120.5, [])).toBe(120);
  });

  it("moves back to the start of a booking the scroller's end would leave cut under the room names", () => {
    expect(reachableLine(130, 120.5, [{ start: 111, end: 126 }])).toBe(111);
    expect(
      reachableLine(130, 120.5, [
        { start: 111, end: 126 },
        { start: 104, end: 113 },
      ]),
    ).toBe(104);
  });

  it("keeps a booking that starts on the line it opens at whole", () => {
    expect(reachableLine(130, 120.5, [{ start: 120, end: 126 }])).toBe(120);
  });

  it("never opens before the grid's first line", () => {
    expect(reachableLine(30, 0.4, [])).toBe(1);
  });
});

describe("where the board stands when it takes over from the plain timeline (U8b)", () => {
  it("keeps its own opening when the plain timeline is where it opened", () => {
    expect(takeOverScroll({ plainScroll: 480, plainOpenedAt: 480, ownOpening: 480 })).toBe(480);
  });

  it("keeps its own opening when the plain timeline had not opened yet, and stands at the day's start", () => {
    expect(takeOverScroll({ plainScroll: 0, plainOpenedAt: null, ownOpening: 480 })).toBe(480);
  });

  it("takes the plain timeline's place when the practice has scrolled it, before or after it opened", () => {
    expect(takeOverScroll({ plainScroll: 333, plainOpenedAt: 480, ownOpening: 480 })).toBe(333);
    expect(takeOverScroll({ plainScroll: 0, plainOpenedAt: 480, ownOpening: 480 })).toBe(0);
    expect(takeOverScroll({ plainScroll: 120, plainOpenedAt: null, ownOpening: 480 })).toBe(120);
  });
});
