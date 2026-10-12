import { describe, expect, it } from "vitest";

import { replayRecorded } from "./support";

describe("P2, capture less than held, over the sandbox's recorded answers", () => {
  it("captures £64.00 of a £100.00 hold as final, and the authorisation reads CAPTURED", async () => {
    const { replayed } = await replayRecorded("P2");

    expect(replayed.outcome).toMatchObject({
      verdict: "pass",
      observations: {
        "capture status": "COMPLETED",
        "captured (pence)": 6_400,
        "final_capture echoed": true,
        "fee currency": "GBP",
        "authorisation status after": "CAPTURED",
      },
    });
    expect(replayed.cleanup?.clean).toBe(true);
  });
});
