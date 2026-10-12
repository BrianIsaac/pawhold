import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type AllocatableHold,
  allocateBill,
  approvalsByHold,
  type BillAmount,
} from "@/money/allocation";
import { MoneyError } from "@/money/errors";

const CODES = ["GA-DENT", "DEN-SP", "DEN-EXT", "LAB-PRE", "XR-DENT", "MED-AB"] as const;

/** A version as its hold approved it: each item's top, by code. */
const versionArbitrary = fc.dictionary(
  fc.constantFrom(...CODES),
  fc.integer({ min: 1, max: 200_000 }),
  { minKeys: 1 },
);

/**
 * Holds made from a run of versions, each a hold for the increase over the
 * last (D3); versions that add nothing make no hold.
 */
const holdsArbitrary = fc.array(versionArbitrary, { minLength: 1, maxLength: 4 }).map((versions) =>
  approvalsByHold(
    versions.map((items, at) => ({
      holdId: `hold-${at + 1}`,
      items: Object.entries(items).map(([code, highPence]) => ({ code, highPence })),
    })),
  ),
);

/** A bill: lines of the codes held, any amounts. */
const billArbitrary = fc.array(
  fc.record({ code: fc.constantFrom(...CODES), amountPence: fc.integer({ min: 1, max: 300_000 }) }),
  { maxLength: 8 },
);

const held = (holds: readonly AllocatableHold[]) =>
  holds.reduce((sum, one) => sum + one.amountPence, 0);
const billed = (lines: readonly BillAmount[]) =>
  lines.reduce((sum, line) => sum + line.amountPence, 0);

describe("the allocation of a bill's lines to holds (plan 3.2, rules 1 and 2)", () => {
  it("rule 1 (property): a case's captures never exceed its holds, nor any hold's captures the hold", () => {
    fc.assert(
      fc.property(holdsArbitrary, billArbitrary, (holds, lines) => {
        if (billed(lines) > held(holds)) {
          expect(() => allocateBill(holds, lines)).toThrow(MoneyError);
          return;
        }
        const plan = allocateBill(holds, lines);
        for (const one of holds) {
          expect(plan.byHold.get(one.id) ?? 0).toBeLessThanOrEqual(one.amountPence);
        }
        const total = [...plan.byHold.values()].reduce((sum, pence) => sum + pence, 0);
        expect(total).toBe(billed(lines));
        expect(total).toBeLessThanOrEqual(held(holds));
        expect(plan.releasedPence).toBe(held(holds) - total);
        plan.byLine.forEach((parts, at) => {
          expect(parts.reduce((sum, part) => sum + part.amountPence, 0)).toBe(
            lines[at]!.amountPence,
          );
          for (const part of parts) {
            expect(part.amountPence).toBeGreaterThan(0);
          }
        });
      }),
      { numRuns: 500 },
    );
  });

  it("rule 2 (property): a bill within what each owner approved is paid by the holds that approved it", () => {
    // Versions that only ever add: each step raises some items' tops.
    const grown = fc
      .array(fc.dictionary(fc.constantFrom(...CODES), fc.integer({ min: 0, max: 100_000 })), {
        minLength: 1,
        maxLength: 4,
      })
      .map((steps) => {
        const versions: Record<string, number>[] = [];
        let running: Record<string, number> = {};
        for (const step of steps) {
          running = { ...running };
          for (const [code, more] of Object.entries(step)) {
            running[code] = (running[code] ?? 0) + more;
          }
          versions.push(running);
        }
        return versions;
      });
    fc.assert(
      fc.property(grown, fc.double({ min: 0, max: 1, noNaN: true }), (versions, share) => {
        const holds = approvalsByHold(
          versions.map((items, at) => ({
            holdId: `hold-${at + 1}`,
            items: Object.entries(items).map(([code, highPence]) => ({ code, highPence })),
          })),
        );
        const last = versions.at(-1)!;
        const lines = Object.entries(last)
          .map(([code, top]) => ({ code, amountPence: Math.floor(top * share) }))
          .filter((line) => line.amountPence > 0);
        const plan = allocateBill(holds, lines);
        plan.byLine.forEach((parts, at) => {
          for (const part of parts) {
            const approver = holds.find((one) => one.id === part.holdId)!;
            expect(approver.approved.get(lines[at]!.code) ?? 0).toBeGreaterThan(0);
          }
        });
      }),
      { numRuns: 500 },
    );
  });

  it("rule 2: an update's lines go first to the update's hold, the rest to the holds in the order made", () => {
    const holds = approvalsByHold([
      {
        holdId: "first",
        items: [
          { code: "GA-DENT", highPence: 32_000 },
          { code: "DEN-SP", highPence: 18_500 },
          { code: "DEN-EXT", highPence: 19_600 },
          { code: "LAB-PRE", highPence: 7_200 },
        ],
      },
      {
        holdId: "update",
        items: [
          { code: "GA-DENT", highPence: 32_000 },
          { code: "DEN-SP", highPence: 18_500 },
          { code: "DEN-EXT", highPence: 19_600 },
          { code: "LAB-PRE", highPence: 7_200 },
          { code: "XR-DENT", highPence: 12_000 },
          { code: "MED-AB", highPence: 3_500 },
        ],
      },
    ]);
    expect(holds.map((one) => [one.id, one.amountPence])).toEqual([
      ["first", 77_300],
      ["update", 15_500],
    ]);

    const plan = allocateBill(holds, [
      { code: "GA-DENT", amountPence: 32_000 },
      { code: "DEN-SP", amountPence: 18_500 },
      { code: "DEN-EXT", amountPence: 9_800 },
      { code: "LAB-PRE", amountPence: 7_200 },
      { code: "XR-DENT", amountPence: 12_000 },
    ]);

    expect(
      plan.byLine.map((parts) => parts.map((part) => [part.holdId, part.amountPence])),
    ).toEqual([
      [["first", 32_000]],
      [["first", 18_500]],
      [["first", 9_800]],
      [["first", 7_200]],
      [["update", 12_000]],
    ]);
    expect(Object.fromEntries(plan.byHold)).toEqual({ first: 67_500, update: 12_000 });
    expect(plan.releasedPence).toBe(13_300);
  });

  it("rule 2: an item an update increased is paid from the first hold up to what it approved, then the update's", () => {
    const holds = approvalsByHold([
      {
        holdId: "first",
        items: [
          { code: "DEN-EXT", highPence: 9_800 },
          { code: "GA-DENT", highPence: 32_000 },
        ],
      },
      {
        holdId: "update",
        items: [
          { code: "DEN-EXT", highPence: 29_400 },
          { code: "GA-DENT", highPence: 32_000 },
        ],
      },
    ]);

    const plan = allocateBill(holds, [{ code: "DEN-EXT", amountPence: 19_600 }]);

    expect(plan.byLine[0]).toEqual([
      { line: 0, holdId: "first", amountPence: 9_800 },
      { line: 0, holdId: "update", amountPence: 9_800 },
    ]);
  });

  it("rule 1: a bill above the holds is refused, never captured in part", () => {
    const holds = approvalsByHold([
      { holdId: "only", items: [{ code: "GA-DENT", highPence: 32_000 }] },
    ]);

    const refused = (() => {
      try {
        allocateBill(holds, [{ code: "GA-DENT", amountPence: 32_001 }]);
      } catch (error) {
        return error;
      }
      return null;
    })();

    expect(refused).toBeInstanceOf(MoneyError);
    expect((refused as MoneyError).reason).toBe("bill_above_holds");
  });

  it("makes no hold for a version that adds nothing", () => {
    const holds = approvalsByHold([
      { holdId: "first", items: [{ code: "GA-DENT", highPence: 32_000 }] },
      { holdId: "same", items: [{ code: "GA-DENT", highPence: 32_000 }] },
    ]);

    expect(holds.map((one) => one.id)).toEqual(["first"]);
  });
});
