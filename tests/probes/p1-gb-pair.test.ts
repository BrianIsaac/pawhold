import { describe, expect, it } from "vitest";

import { replayRecorded } from "./support";

describe("P1, the GB pair, over the sandbox's recorded answers", () => {
  it("authorises £100.00 GBP approved by a GB payer, then voids it", async () => {
    const { replayed } = await replayRecorded("P1");

    expect(replayed.outcome).toMatchObject({
      verdict: "pass",
      observations: {
        "authorisation status": "CREATED",
        "held (pence)": 10_000,
        currency: "GBP",
        "payer country": "GB",
      },
    });
    expect(replayed.cleanup?.rows.map((r) => r.status)).toEqual(["VOIDED"]);
  });
});
