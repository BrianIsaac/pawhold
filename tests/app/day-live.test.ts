import { describe, expect, it } from "vitest";

import { FRESH, liveStep, READ_AGAIN_AFTER } from "../../app/(practice)/day/live";

/*
 * What the open day does with each answer to "has anything changed?" (U8b):
 * it reads the day again when the stamp is not the one it was drawn from,
 * once for each stamp, and again if the day it was given still is not that
 * stamp's a few answers later (a read that was dropped), so a change is
 * never missed for good and never asked for in a storm.
 */

describe("the open day's answer to a stamp", () => {
  it("does nothing while the stamp is the one the page was drawn from", () => {
    expect(liveStep(FRESH, "7", "7")).toEqual({ read: false, memory: FRESH });
  });

  it("reads the day again when the stamp has moved, once", () => {
    const first = liveStep(FRESH, "7", "9");
    const second = liveStep(first.memory, "7", "9");

    expect(first.read).toBe(true);
    expect(second.read).toBe(false);
  });

  it("reads it again if the page still is not drawn from that stamp a few answers later", () => {
    let memory = liveStep(FRESH, "7", "9").memory;
    const reads: boolean[] = [];
    for (let answer = 0; answer < READ_AGAIN_AFTER * 2; answer += 1) {
      const step = liveStep(memory, "7", "9");
      reads.push(step.read);
      memory = step.memory;
    }

    expect(reads.filter(Boolean)).toHaveLength(2);
    expect(reads[READ_AGAIN_AFTER - 1]).toBe(true);
    expect(reads.slice(0, READ_AGAIN_AFTER - 1)).not.toContain(true);
  });

  it("starts afresh once the page is drawn from the stamp, and reads at once for a newer one", () => {
    const asked = liveStep(FRESH, "7", "9").memory;

    expect(liveStep(asked, "9", "9")).toEqual({ read: false, memory: FRESH });
    expect(liveStep(asked, "7", "12").read).toBe(true);
  });
});
