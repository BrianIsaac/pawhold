import { beforeEach, describe, expect, it } from "vitest";

import { loadDischargeView, reviewBill } from "@/discharge/bill";
import { NOT_ON_ESTIMATE } from "@/discharge/wording";
import { NOT_ON_ESTIMATE as MONEY_NOT_ON_ESTIMATE } from "@/money/discharge";
import { PracticeError } from "@/practice/errors";

import { connectTestDatabase } from "../support/database";
import { DENTAL_UPDATE_LINES, makeDentalCase, type MoneyFixture } from "../support/money";
import { startPayPalDouble } from "../support/paypal-double";
import { heldVersion, quantitiesOf } from "./support";

const { db } = connectTestDatabase();
const paypal = startPayPalDouble();

let fixture: MoneyFixture;

beforeEach(async () => {
  fixture = await makeDentalCase(db);
});

describe("the itemised bill (section 6, the practice: discharge)", () => {
  it("lists the approved estimate's lines, grouped by the version that approved them, each at its estimate's low", async () => {
    await heldVersion({ db, paypal }, fixture);
    await heldVersion({ db, paypal }, fixture, DENTAL_UPDATE_LINES);

    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);

    expect(view.groups.map((group) => group.heading)).toEqual([
      "Approved with the estimate",
      "Approved with the update",
    ]);
    expect(
      view.groups[0]!.lines.map((line) => [line.code, line.quantityLow, line.quantityHigh]),
    ).toEqual([
      ["GA-DENT", 1, 1],
      ["DEN-SP", 1, 1],
      ["DEN-EXT", 0, 2],
      ["LAB-PRE", 1, 1],
    ]);
    expect(view.groups[1]!.lines.map((line) => line.code)).toEqual(["XR-DENT", "MED-AB"]);
    expect(view.heldPence).toBe(77_300 + 15_500);
    expect(view.signed).toBeNull();
    expect(view.seeded).toBe(false);
    expect(view.unlisted.flatMap((group) => group.items).map((item) => item.code)).toEqual([
      "CON-STD",
    ]);

    const review = await reviewBill(db, {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      quantities: quantitiesOf(view),
      extras: [],
    });
    // GA £320 + scale £185 + no extraction + bloods £72 + rads £120 + antibiotics £35.
    expect(review.billedPence).toBe(73_200);
    expect(review.lines.map((line) => line.amountPence)).toEqual([
      32_000, 18_500, 0, 7_200, 12_000, 3_500,
    ]);
    expect(review.lines.every((line) => line.issue === null)).toBe(true);
  });

  it("charges a quantity done up to what the owner approved", async () => {
    await heldVersion({ db, paypal }, fixture);
    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);
    const extraction = view.groups[0]!.lines.find((line) => line.code === "DEN-EXT")!;

    const review = await reviewBill(db, {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      quantities: { ...quantitiesOf(view), [extraction.estimateLineId]: "2" },
      extras: [],
    });

    expect(review.billedPence).toBe(32_000 + 18_500 + 2 * 9_800 + 7_200);
    expect(review.verdict.kind).not.toBe("refused");
  });

  it("refuses a line not on any approved estimate with section 6's sentence, and never charges it", async () => {
    await heldVersion({ db, paypal }, fixture);
    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);

    const review = await reviewBill(db, {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      quantities: quantitiesOf(view),
      extras: [{ code: "XR-DENT", quantity: "1" }],
    });

    expect(review.extras).toEqual([
      expect.objectContaining({
        code: "XR-DENT",
        quantity: 1,
        amountPence: 12_000,
        issue: NOT_ON_ESTIMATE,
      }),
    ]);
    expect(review.billedPence).toBe(32_000 + 18_500 + 7_200);
  });

  it("refuses a quantity above the approved one, naming both", async () => {
    await heldVersion({ db, paypal }, fixture);
    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);
    const extraction = view.groups[0]!.lines.find((line) => line.code === "DEN-EXT")!;

    const review = await reviewBill(db, {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      quantities: { ...quantitiesOf(view), [extraction.estimateLineId]: "3" },
      extras: [],
    });

    const line = review.lines.find((one) => one.estimateLineId === extraction.estimateLineId)!;
    expect(line.issue).toBe("3 done, 2 approved. Send an update to charge the rest.");
    expect(review.verdict.kind).toBe("refused");
  });

  it("asks for a whole number and refuses anything else", async () => {
    await heldVersion({ db, paypal }, fixture);
    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);
    const first = view.groups[0]!.lines[0]!;

    const review = await reviewBill(db, {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      quantities: { ...quantitiesOf(view), [first.estimateLineId]: "1e1" },
      extras: [],
    });

    expect(review.lines[0]!.issue).toBe("Enter a whole number");
    expect(review.verdict).toEqual({
      kind: "refused",
      reason: "Every quantity done must be a whole number.",
    });
  });

  it("refuses a work line for an item already on the bill, and an item not on the price list", async () => {
    await heldVersion({ db, paypal }, fixture);
    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);

    await expect(
      reviewBill(db, {
        practiceId: fixture.practiceId,
        caseId: fixture.caseId,
        quantities: quantitiesOf(view),
        extras: [{ code: "GA-DENT", quantity: "1" }],
      }),
    ).rejects.toBeInstanceOf(PracticeError);
    await expect(
      reviewBill(db, {
        practiceId: fixture.practiceId,
        caseId: fixture.caseId,
        quantities: quantitiesOf(view),
        extras: [{ code: "NOT-LISTED", quantity: "1" }],
      }),
    ).rejects.toBeInstanceOf(PracticeError);
  });

  it("refuses a bill for a line the page did not show", async () => {
    await heldVersion({ db, paypal }, fixture);
    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);

    await expect(
      reviewBill(db, {
        practiceId: fixture.practiceId,
        caseId: fixture.caseId,
        quantities: { ...quantitiesOf(view), "0b7d2f53-5d4e-4c1a-9a65-6c5f7e8f9a10": "1" },
        extras: [],
      }),
    ).rejects.toMatchObject({ reason: "stale" });
  });

  it("is the practice's own: another practice's case is not found", async () => {
    await heldVersion({ db, paypal }, fixture);
    const other = await makeDentalCase(db, "Another practice");

    await expect(loadDischargeView(db, other.practiceId, fixture.caseId)).rejects.toMatchObject({
      reason: "case_not_found",
    });
  });

  it("shows a case with nothing held, with nothing to bill", async () => {
    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);
    expect(view.groups).toEqual([]);
    expect(view.heldPence).toBe(0);
  });
});

describe("the discharge page's words", () => {
  it("refuse a line off the estimate in U3's words, which are section 6's", () => {
    expect(NOT_ON_ESTIMATE).toBe(MONEY_NOT_ON_ESTIMATE);
  });
});
