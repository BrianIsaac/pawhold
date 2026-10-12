import { describe, expect, it } from "vitest";

import { replayRecorded } from "./support";

describe("P7, two orders from one buyer, over the sandbox's recorded answers", () => {
  it("authorises a second order while the first is held, captures both and voids the second's rest", async () => {
    const { replayed } = await replayRecorded("P7");

    expect(replayed.outcome).toMatchObject({
      verdict: "pass",
      observations: {
        "second authorisation status": "CREATED",
        "first authorisation status once the second was made": "CREATED",
        "first capture status": "COMPLETED",
        "second capture status": "COMPLETED",
        "first authorisation status after": "CAPTURED",
        "second authorisation status after": "VOIDED",
      },
    });
    expect(replayed.cleanup?.rows).toHaveLength(2);
    expect(replayed.cleanup?.clean).toBe(true);
  });
});
