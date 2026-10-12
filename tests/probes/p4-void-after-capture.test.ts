import { describe, expect, it } from "vitest";

import { replayRecorded } from "./support";

describe("P4, void after a partial capture, over the sandbox's recorded answers", () => {
  it("voids the rest after £60.00 was captured not final; the capture stands", async () => {
    const { replayed } = await replayRecorded("P4");

    expect(replayed.outcome).toMatchObject({
      verdict: "pass",
      observations: {
        "authorisation status between": "PARTIALLY_CAPTURED",
        "void answered": "VOIDED",
        "authorisation status after": "VOIDED",
        "capture status after": "COMPLETED",
        "captured (pence)": 6_000,
      },
    });
    expect(replayed.cleanup?.rows.map((r) => r.status)).toEqual(["VOIDED"]);
  });
});
