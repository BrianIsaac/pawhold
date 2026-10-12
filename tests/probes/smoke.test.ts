import { describe, expect, it } from "vitest";

import { replayRecorded } from "./support";

describe("the smoke run, over the sandbox's recorded answers", () => {
  it("authorises, voids and reads the authorisation back VOIDED, leaving nothing held", async () => {
    const { replayed } = await replayRecorded("SMOKE");

    expect(replayed.outcome?.verdict).toBe("pass");
    expect(replayed.outcome?.observations["authorisation status read back"]).toBe("VOIDED");
    expect(replayed.cleanup?.clean).toBe(true);
  });
});
