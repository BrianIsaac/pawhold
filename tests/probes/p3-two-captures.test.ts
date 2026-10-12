import { describe, expect, it } from "vitest";

import { replayRecorded } from "./support";

describe("P3, two captures against one hold, over the sandbox's recorded answers", () => {
  it("completes £60.00 not final then £30.00 final, the authorisation going PARTIALLY_CAPTURED then CAPTURED", async () => {
    const { replayed } = await replayRecorded("P3");

    expect(replayed.outcome).toMatchObject({
      verdict: "pass",
      observations: {
        "first capture status": "COMPLETED",
        "first captured (pence)": 6_000,
        "authorisation status between": "PARTIALLY_CAPTURED",
        "second capture status": "COMPLETED",
        "second captured (pence)": 3_000,
        "authorisation status after": "CAPTURED",
      },
      branch: null,
    });
  });
});
