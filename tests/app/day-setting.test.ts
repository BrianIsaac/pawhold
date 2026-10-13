import { describe, expect, it } from "vitest";

import { dayBoardSetting } from "../../app/(practice)/day/setting";

/*
 * The setting that keeps the day on the plain timeline (U8b):
 * `PAWHOLD_DAY_BOARD=plain`, for judge mode's fallback.
 */

describe("the setting that keeps the day on the plain timeline", () => {
  it("leaves the board on when it is not set", () => {
    expect(dayBoardSetting({})).toBe("scheduler");
    expect(dayBoardSetting({ PAWHOLD_DAY_BOARD: "" })).toBe("scheduler");
    expect(dayBoardSetting({ PAWHOLD_DAY_BOARD: "scheduler" })).toBe("scheduler");
  });

  it("forces the plain timeline with PAWHOLD_DAY_BOARD=plain", () => {
    expect(dayBoardSetting({ PAWHOLD_DAY_BOARD: "plain" })).toBe("plain");
    expect(dayBoardSetting({ PAWHOLD_DAY_BOARD: " Plain " })).toBe("plain");
  });

  it("falls to the plain timeline for a value it does not know, the floor being the safe side", () => {
    expect(dayBoardSetting({ PAWHOLD_DAY_BOARD: "plian" })).toBe("plain");
  });
});
