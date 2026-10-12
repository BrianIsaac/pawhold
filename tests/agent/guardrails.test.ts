import { describe, expect, it } from "vitest";

import { checkOwnerWording, findSpan, guardLines, type GuardItem } from "@/agent/guardrails";
import { parsePriceList } from "@/estimate/price-list";

import { readSeedPriceList } from "../../seed/practice";

/** Plan 3.4's own example of a vet's notes. */
const NOTES = "GA, dental scale and polish, probable two extractions upper PM, pre-op bloods";

const ITEMS: ReadonlyMap<string, GuardItem> = new Map(
  parsePriceList(readSeedPriceList()).map((entry) => [entry.code, { name: entry.name }]),
);

/**
 * A drafted line as the model returns it, with plain defaults.
 *
 * @param fields - The fields to set.
 * @returns The line.
 */
function line(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    quantityLow: 1,
    quantityHigh: 1,
    dependsOn: null,
    ownerWording: "A plain description",
    ...fields,
  };
}

describe("a code the model returns must be on the practice's list", () => {
  // Plan 5, U4's acceptance: "a code not in the list is dropped and its span shown as unmatched".
  it("drops a code not in the list and shows its span as unmatched", () => {
    const guarded = guardLines(
      [
        line({ code: "DEN-SP", notesSpan: "dental scale and polish" }),
        line({ code: "DEN-EXT-PM", notesSpan: "probable two extractions upper PM" }),
      ],
      [],
      NOTES,
      ITEMS,
    );

    expect(guarded.kept.map((kept) => kept.line.code)).toEqual(["DEN-SP"]);
    expect(guarded.unmatched).toEqual([
      {
        notesSpan: "probable two extractions upper PM",
        start: NOTES.indexOf("probable"),
        end: NOTES.indexOf("probable") + "probable two extractions upper PM".length,
        code: "DEN-EXT-PM",
      },
    ]);
    expect(guarded.unsupported).toEqual([]);
  });

  it("shows the spans the model said no item matched, once each", () => {
    const guarded = guardLines(
      [],
      [{ notesSpan: "pre-op bloods" }, { notesSpan: "pre-op bloods" }],
      NOTES,
      ITEMS,
    );
    expect(guarded.unmatched).toEqual([
      { notesSpan: "pre-op bloods", start: NOTES.length - 13, end: NOTES.length, code: null },
    ]);
  });
});

describe("a line's span must appear in the notes", () => {
  // Plan 5, U4's acceptance: "a line whose span is not in the notes is dropped".
  it("drops a line whose span is not in the notes and shows it as unsupported", () => {
    const guarded = guardLines(
      [
        line({ code: "LAB-PRE", notesSpan: "pre-op bloods" }),
        line({ code: "IMG-XR-DENT", notesSpan: "dental radiographs" }),
      ],
      [],
      NOTES,
      ITEMS,
    );

    expect(guarded.kept.map((kept) => kept.line.code)).toEqual(["LAB-PRE"]);
    expect(guarded.unsupported).toEqual([
      {
        reason: "span_not_in_notes",
        code: "IMG-XR-DENT",
        notesSpan: "dental radiographs",
        message: 'the draft quoted "dental radiographs", which is not in the notes',
      },
    ]);
  });

  it("does not show an unknown code's invented span as unmatched", () => {
    const guarded = guardLines(
      [line({ code: "DEN-XYZ", notesSpan: "full mouth radiographs" })],
      [{ notesSpan: "hydrotherapy" }],
      NOTES,
      ITEMS,
    );
    expect(guarded.unmatched).toEqual([]);
    expect(guarded.unsupported.map((dropped) => dropped.notesSpan)).toEqual([
      "full mouth radiographs",
      "hydrotherapy",
    ]);
  });

  it("keeps the span as the notes wrote it, with where it sits", () => {
    const notes = "GA,  dental scale\nand polish";
    const guarded = guardLines(
      [line({ code: "DEN-SP", notesSpan: "dental scale and polish" })],
      [],
      notes,
      ITEMS,
    );
    expect(guarded.kept[0]).toMatchObject({
      line: { notesSpan: "dental scale\nand polish" },
      start: 5,
      end: notes.length,
    });
  });

  it("refuses a span that only matches inside a word", () => {
    expect(findSpan("GAstric lavage", "GA")).toBeNull();
    expect(findSpan("GA, dental", "GA")).toEqual({ start: 0, end: 2, text: "GA" });
  });

  it("is case-sensitive and refuses a span of no letters or digits", () => {
    expect(findSpan(NOTES, "ga")).toBeNull();
    expect(findSpan(NOTES, ", ")).toBeNull();
    expect(findSpan(NOTES, "  ")).toBeNull();
  });
});

describe("the owner's wording", () => {
  // Plan 5, U4's acceptance: "an owner's wording with a currency amount, a
  // percentage or a dose falls back to the item's own name".
  it.each([
    ["a currency amount", "Blood test, about £72", "currency"],
    ["a currency amount in pence", "Collar, 15p each", "currency"],
    ["a currency word", "Twenty pounds for the blood test", "currency"],
    ["a percentage", "Covers 20% of the work", "percentage"],
    ["a percentage in words", "Half of it, fifty per cent", "percentage"],
    ["a dose", "Pain relief, 0.2 mg/kg by injection", "dose"],
    ["a dose in millilitres", "Liquid pain relief, 5 ml", "dose"],
    ["a dose in tablets", "Antibiotics, 2 tablets twice a day", "dose"],
    ["a dosing frequency", "Ear drops BID for a week", "dose"],
  ])("falls back to the item's own name for %s", (_case, wording, reason) => {
    expect(checkOwnerWording(wording)).toBe(reason);
    const guarded = guardLines(
      [line({ code: "LAB-PRE", notesSpan: "pre-op bloods", ownerWording: wording })],
      [],
      NOTES,
      ITEMS,
    );
    expect(guarded.kept[0]).toMatchObject({
      line: { code: "LAB-PRE", ownerWording: "Pre-anaesthetic blood screen" },
      ownerWordingFellBack: reason,
    });
  });

  it("keeps plain wording", () => {
    const guarded = guardLines(
      [
        line({
          code: "LAB-PRE",
          notesSpan: "pre-op bloods",
          ownerWording: "A blood test to check it is safe to anaesthetise",
        }),
      ],
      [],
      NOTES,
      ITEMS,
    );
    expect(guarded.kept[0]).toMatchObject({
      line: { ownerWording: "A blood test to check it is safe to anaesthetise" },
      ownerWordingFellBack: null,
    });
  });

  it.each([
    "Removing up to two teeth, if needed",
    "An anaesthetic for a dog under 20 kg",
    "A 7-day course of antibiotic tablets",
    "One night in the hospital with nursing checks",
  ])("does not mistake %j for an amount or a dose", (wording) => {
    expect(checkOwnerWording(wording)).toBeNull();
  });

  it("finds nothing to refuse in any of the seed list's own names", () => {
    for (const [code, item] of ITEMS) {
      expect(checkOwnerWording(item.name), code).toBeNull();
    }
  });
});

describe("a line the model got wrong in shape", () => {
  it("drops a line whose low quantity is above its high one", () => {
    const guarded = guardLines(
      [line({ code: "DEN-EXT-S", notesSpan: "two extractions", quantityLow: 3, quantityHigh: 2 })],
      [],
      NOTES,
      ITEMS,
    );
    expect(guarded.kept).toEqual([]);
    expect(guarded.unsupported).toEqual([
      expect.objectContaining({ reason: "invalid_line", code: "DEN-EXT-S" }),
    ]);
  });

  it("drops a line given a price, never pricing from it", () => {
    const guarded = guardLines(
      [line({ code: "LAB-PRE", notesSpan: "pre-op bloods", unitPricePence: 1 })],
      [],
      NOTES,
      ITEMS,
    );
    expect(guarded.kept).toEqual([]);
    expect(guarded.unsupported[0]?.reason).toBe("invalid_line");
  });

  it("keeps a line's dependency on a finding", () => {
    const guarded = guardLines(
      [
        line({
          code: "DEN-EXT-SG",
          notesSpan: "probable two extractions upper PM",
          quantityLow: 0,
          quantityHigh: 2,
          dependsOn: "extractions are needed",
        }),
      ],
      [],
      NOTES,
      ITEMS,
    );
    expect(guarded.kept[0]?.line).toEqual({
      code: "DEN-EXT-SG",
      quantityLow: 0,
      quantityHigh: 2,
      dependsOn: "extractions are needed",
      notesSpan: "probable two extractions upper PM",
      ownerWording: "A plain description",
    });
  });
});
