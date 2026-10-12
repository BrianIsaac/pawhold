import { describe, expect, it } from "vitest";

import { shownAs } from "../../probes/p9-buyer-account";

import { replayRecorded } from "./support";

describe("P9, the buyer's account, over the sandbox's recorded answers and readings", () => {
  it("sees the hold as an Authorisation, then the capture as a Payment, each within a minute", async () => {
    const { replayed } = await replayRecorded("P9");
    const seen = replayed.outcome!.observations;

    expect(replayed.outcome?.verdict).toBe("pass");
    expect(seen["hold shown as"]).toMatch(
      /^Test Store −£\d+\.\d{2} Today, \d+ Oct \. Authorisation$/,
    );
    expect(seen["capture shown as"]).toMatch(/ Payment$/);
    expect(seen["seconds to show the hold"]).toBeLessThanOrEqual(60);
    expect(seen["seconds to show the capture"]).toBeLessThanOrEqual(60);
    expect(seen["capture status"]).toBe("COMPLETED");
    expect(replayed.cleanup?.clean).toBe(true);
  });
});

describe("amounts as the buyer's account writes them", () => {
  it.each([
    [5_782, "£57.82"],
    [100, "£1.00"],
    [7, "£0.07"],
    [500_000, "£5,000.00"],
  ])("writes %i pence as %s", (pence, text) => {
    expect(shownAs(pence)).toBe(text);
  });
});
