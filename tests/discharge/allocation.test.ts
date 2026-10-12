import { beforeEach, describe, expect, it } from "vitest";

import { loadDischargeView, reviewBill } from "@/discharge/bill";
import { allocationSentence, confirmLabel } from "@/discharge/wording";

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

/**
 * A plan's holds as the sentence reads them.
 *
 * @param holds - Each hold's capture and release, in the order made.
 * @returns The holds.
 */
function holds(...holds: [number, number][]) {
  return holds.map(([capturePence, releasePence]) => ({ capturePence, releasePence }));
}

describe("the allocation sentence (section 6: before confirming)", () => {
  it("reads as section 6 drafts it for two holds", () => {
    expect(allocationSentence(holds([57_700, 19_600], [15_500, 0]), "GBP", "Ann")).toBe(
      "£732.00 will be captured: £577.00 from the first hold, £155.00 from the update's hold. £196.00 will be released to Ann.",
    );
  });

  it("names the one hold of a case without an update", () => {
    expect(allocationSentence(holds([57_700, 19_600]), "GBP", "Ann")).toBe(
      "£577.00 will be captured from the hold. £196.00 will be released to Ann.",
    );
  });

  it("names each update's hold in order when there are several", () => {
    expect(allocationSentence(holds([50_000, 0], [10_000, 2_000], [0, 5_000]), "GBP", "Ann")).toBe(
      "£600.00 will be captured: £500.00 from the first hold, £100.00 from the first update's hold, nothing from the second update's hold. £70.00 will be released to Ann.",
    );
  });

  it("says when nothing is left to release, and when nothing is charged", () => {
    expect(allocationSentence(holds([77_300, 0], [15_500, 0]), "GBP", "Ann")).toBe(
      "£928.00 will be captured: £773.00 from the first hold, £155.00 from the update's hold. Nothing is left to release.",
    );
    expect(allocationSentence(holds([0, 77_300]), "GBP", "Ann")).toBe(
      "Nothing will be captured. £773.00 will be released to Ann.",
    );
  });

  it("labels the confirm button with what is charged (section 6), or what is released when nothing is", () => {
    expect(confirmLabel(73_200, 0, "GBP")).toBe("Confirm and charge £732.00");
    expect(confirmLabel(0, 77_300, "GBP")).toBe("Confirm and release £773.00");
  });
});

describe("the bill's allocation, from U3's planDischarge", () => {
  it("shows the two-hold bill's capture from each hold and the release, before anything is confirmed", async () => {
    await heldVersion({ db, paypal }, fixture);
    await heldVersion({ db, paypal }, fixture, DENTAL_UPDATE_LINES);
    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);

    const review = await reviewBill(db, {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      quantities: quantitiesOf(view),
      extras: [],
    });

    expect(review.verdict).toEqual({
      kind: "ready",
      holds: [
        expect.objectContaining({ capturePence: 57_700, releasePence: 19_600 }),
        expect.objectContaining({ capturePence: 15_500, releasePence: 0 }),
      ],
      sentence:
        "£732.00 will be captured: £577.00 from the first hold, £155.00 from the update's hold. £196.00 will be released to Ann.",
      confirm: "Confirm and charge £732.00",
      blocked: null,
    });
    expect(paypal.posts(/capture|void/)).toEqual([]);
  });

  it("a bill above the holds cannot be confirmed", async () => {
    await heldVersion({ db, paypal }, fixture);
    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);
    const extraction = view.groups[0]!.lines.find((line) => line.code === "DEN-EXT")!;

    const review = await reviewBill(db, {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      quantities: { ...quantitiesOf(view), [extraction.estimateLineId]: "5" },
      extras: [],
    });

    expect(review.billedPence).toBe(106_700);
    expect(review.verdict).toEqual({
      kind: "refused",
      reason:
        "The bill is £1,067.00, above the £773.00 held. Nothing above a hold is charged: send an update for the rest, or change the bill.",
    });
  });
});
