import { describe, expect, it } from "vitest";

import type { CaseMoney, HoldView } from "@/money/view";
import { moneyChips, nextStep } from "@/practice/chips";

const HOLD: HoldView = {
  id: "00000000-0000-4000-8000-000000000001",
  caseId: "00000000-0000-4000-8000-000000000002",
  versionNumber: 1,
  status: "authorised",
  amount: { pence: 92_700, currency: "GBP" },
  heldBeforePence: 0,
  paypalOrderId: "ORDER",
  authorizationId: "AUTH",
  originalAuthorizationId: "AUTH",
  paymentKind: "paypal",
  authorisedAt: new Date("2026-10-07T08:43:00Z"),
  expiresAt: null,
  reauthorisedAt: null,
  reauthoriseRefusedAt: null,
  honourPeriodFlaggedAt: null,
  confirmedAt: null,
  closedAt: null,
  capturedPence: 0,
  releasedPence: 0,
};

/**
 * A case's money in a state, with the given holds and sums.
 *
 * @param state - The state.
 * @param rest - Holds and sums.
 * @returns The money.
 */
function money(state: CaseMoney["state"], rest: Partial<CaseMoney> = {}): CaseMoney {
  return {
    caseId: HOLD.caseId,
    state,
    currency: "GBP",
    holds: [],
    heldPence: 0,
    capturedPence: 0,
    releasedPence: 0,
    refundedPence: 0,
    ...rest,
  };
}

describe("the money chips (section 6, U3's map)", () => {
  it.each([
    ["estimate_draft", "Estimate draft"],
    ["awaiting_owner", "Waiting for owner"],
    ["update_awaiting_owner", "Update waiting"],
    ["update_declined", "Update declined"],
    ["withdrawn", "Withdrawn"],
  ] as const)("%s reads %s", (state, label) => {
    expect(moneyChips(money(state))).toEqual([{ tone: state, label }]);
  });

  it("held reads Held {amount}, what the open holds hold", () => {
    expect(moneyChips(money("held", { heldPence: 92_700 }))).toEqual([
      { tone: "held", label: "Held £927.00" },
    ]);
  });

  it("captured, released and refunded carry their amounts", () => {
    expect(moneyChips(money("captured", { capturedPence: 32_000 }))[0]?.label).toBe(
      "Captured £320.00",
    );
    expect(moneyChips(money("released", { releasedPence: 45_300 }))[0]?.label).toBe(
      "Released £453.00",
    );
    expect(moneyChips(money("refunded", { refundedPence: 1_000 }))[0]?.label).toBe(
      "Refunded £10.00",
    );
  });

  it("an open hold reauthorised adds Hold extended beside the case's chip", () => {
    const chips = moneyChips(
      money("update_declined", {
        holds: [{ ...HOLD, reauthorisedAt: new Date("2026-10-11T08:45:00Z") }],
        heldPence: 92_700,
      }),
    );

    expect(chips).toEqual([
      { tone: "update_declined", label: "Update declined" },
      { tone: "extended", label: "Hold extended" },
    ]);
  });

  it("an open hold past its honour period adds Honour period over, once however many holds", () => {
    const flagged = { ...HOLD, honourPeriodFlaggedAt: new Date("2026-10-11T08:45:00Z") };
    const chips = moneyChips(money("held", { holds: [flagged, flagged], heldPence: 1 }));

    expect(chips.map((chip) => chip.label)).toEqual(["Held £0.01", "Honour period over"]);
  });

  it("a closed hold's flags are not shown: nothing of it is held any more", () => {
    const closed = { ...HOLD, status: "captured" as const, reauthorisedAt: new Date() };
    expect(moneyChips(money("captured", { holds: [closed] }))).toHaveLength(1);
  });
});

describe("the next thing to do", () => {
  const owner = "Nadia";

  it.each([
    ["estimate_draft", false, "Draft the estimate"],
    ["estimate_draft", true, "Review and send the estimate"],
    ["awaiting_owner", true, "Wait for Nadia to authorise the hold"],
    ["held", true, "Add an update, or discharge"],
    ["update_awaiting_owner", true, "Wait for Nadia to answer the update"],
    ["update_declined", true, "Call Nadia about the update"],
    ["withdrawn", true, "Send the estimate again"],
    ["captured", true, "Nothing to do"],
    ["released", true, "Nothing to do"],
    ["refunded", true, "Nothing to do"],
  ] as const)("%s (a draft: %s) is %s", (state, hasDraft, next) => {
    expect(
      nextStep(state, { ownerFirstName: owner, hasDraftLines: hasDraft, honourPeriodOver: false }),
    ).toBe(next);
  });
});

describe("the next step for a hold past its honour period that cannot be extended (U11)", () => {
  it("asks the owner for a new hold, as U9 found", () => {
    expect(
      nextStep("held", { ownerFirstName: "Carys", hasDraftLines: false, honourPeriodOver: true }),
    ).toBe("Ask Carys for a new hold");
    expect(
      nextStep("held", { ownerFirstName: "Carys", hasDraftLines: false, honourPeriodOver: false }),
    ).toBe("Add an update, or discharge");
  });
});
