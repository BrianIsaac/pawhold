import { describe, expect, it } from "vitest";

import {
  lastStartLine,
  openingLine,
  reachableOpening,
  takeOverScroll,
} from "../../app/(practice)/day/opening";

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

describe("where the day's grid opens when the grid ends before the opening line can be reached", () => {
  it("keeps the opening when the view can start there", () => {
    expect(reachableOpening(40, 40, [{ start: 30, end: 48 }])).toBe(40);
  });

  it("works the opening out again from the last line the view can start at, cutting no booking", () => {
    // Late in the day: the grid can start no later than line 50, which is inside a booking from 49.
    expect(
      reachableOpening(70, 50, [
        { start: 49, end: 65 },
        { start: 72, end: 80 },
      ]),
    ).toBe(49);
    expect(reachableOpening(70, 50, [])).toBe(50);
  });

  it("moves back past a booking that cuts the booking it moved back to, and keeps one starting at the end whole (U16)", () => {
    expect(
      reachableOpening(130, 120, [
        { start: 111, end: 126 },
        { start: 104, end: 113 },
      ]),
    ).toBe(104);
    // A booking from the last line is whole; the opening steps back to leave the hour's label room.
    expect(reachableOpening(130, 120, [{ start: 120, end: 126 }])).toBe(118);
  });

  it("opens at the grid's first line when the whole grid fits the view", () => {
    expect(reachableOpening(20, 0, [])).toBe(1);
  });

  it("reads the last line the view can start at from the scroller's widths", () => {
    // 120 columns of 10 px, 400 px of them in view: the view can start no later than line 81.
    expect(lastStartLine({ scrollWidth: 1300, clientWidth: 500, slotPx: 10 })).toBe(81);
    expect(lastStartLine({ scrollWidth: 1300.4, clientWidth: 500, slotPx: 10 })).toBe(81);
    expect(lastStartLine({ scrollWidth: 500, clientWidth: 500, slotPx: 10 })).toBe(1);
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
