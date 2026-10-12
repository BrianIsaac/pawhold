import { describe, expect, it } from "vitest";

import { highlightSegments } from "@/practice/highlight";

describe("the notes with each line's span marked", () => {
  it("cuts the text into plain runs and marks, each mark naming its lines", () => {
    expect(
      highlightSegments("GA, dental scale and polish", [
        { position: 1, start: 0, end: 2 },
        { position: 2, start: 4, end: 27 },
      ]),
    ).toEqual([
      { text: "GA", positions: [1] },
      { text: ", ", positions: [] },
      { text: "dental scale and polish", positions: [2] },
    ]);
  });

  it("joins spans that overlap or repeat into one mark naming every line", () => {
    expect(
      highlightSegments("Sedate for ear flush.", [
        { position: 1, start: 0, end: 20 },
        { position: 2, start: 0, end: 20 },
        { position: 3, start: 11, end: 14 },
      ]),
    ).toEqual([
      { text: "Sedate for ear flush", positions: [1, 2, 3] },
      { text: ".", positions: [] },
    ]);
  });

  it("is the whole text unmarked when there are no spans", () => {
    expect(highlightSegments("notes", [])).toEqual([{ text: "notes", positions: [] }]);
  });
});
