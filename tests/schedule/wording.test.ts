import { describe, expect, it } from "vitest";

import { DAY_BUTTONS, heldNote, holdReason, moveQuestion } from "@/schedule/wording";

// Section 6, "The practice's day (Bryntum board)", as drafted (D11):
// "A proposal: "Hold theatre 1 at {time}? {owner first name} hasn't approved
// the update for {patient}." with "Hold the slot" and "Dismiss"; for a move:
// "Move {next patient}'s procedure to {time}, after {patient}'s update is
// answered?" with "Move it" and "Dismiss". An applied hold, on the event:
// "Held by pawhold at {time}: waiting for approval. Undo"."

describe("the practice's day in section 6's words", () => {
  it("gives the hold's reason as the drafted proposal's second sentence", () => {
    expect(holdReason("Ellis", "Juno")).toBe("Ellis hasn't approved the update for Juno.");
  });

  it("words the applied hold on the booking", () => {
    expect(heldNote("13:35")).toBe("Held by pawhold at 13:35: waiting for approval.");
  });

  it("asks the move as drafted", () => {
    expect(moveQuestion("Biscuit", "14:05", "Juno")).toBe(
      "Move Biscuit's procedure to 14:05, after Juno's update is answered?",
    );
  });

  it("labels the buttons as drafted", () => {
    expect(DAY_BUTTONS).toEqual({ move: "Move it", dismiss: "Dismiss", undo: "Undo" });
  });
});
