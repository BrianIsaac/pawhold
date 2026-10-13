import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readmeSteps, stepActions } from "../browser/support/readme";

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

describe("the README's testing instructions (U9)", () => {
  it("puts 'Try it' first, with the deployment's address, then the testing instructions", () => {
    const headings = README.split("\n").filter((line) => line.startsWith("## "));

    expect(headings.slice(0, 2)).toEqual(["## Try it", "## Testing instructions"]);
    expect(README).toContain("**<https://pawhold.onrender.com>**");
  });

  it("publishes the sandbox buyer's login and PayPal's GB test card, and says no real money moves", () => {
    expect(README).toMatch(/Email `sb-[a-z0-9]+@personal\.example\.com`, password `[^`]+`/);
    expect(README).toContain("Card `4462 6030 4234 3024`, expiry `12/30`, security code `123`");
    expect(README).toContain("no real money moves");
  });

  it("reads the owner's two minutes as a walk: the door, the estimate, PayPal's window, the hold", () => {
    expect(readmeSteps("Two minutes as the owner").map((step) => step.actions)).toEqual([
      [{ kind: "open", url: "https://pawhold.onrender.com" }],
      [{ kind: "click", name: "Try it as the owner", inDialog: false }],
      [
        { kind: "see", text: "Otis's estimate from Hollins Lane Veterinary Surgery" },
        { kind: "see", text: "What the vet wrote" },
        { kind: "see", text: "Testing in PayPal's sandbox" },
      ],
      [{ kind: "paypal" }],
      [
        { kind: "see", text: "Held" },
        {
          kind: "see",
          text: "Done. £1,010.00 is held on your PayPal. You'll get the final bill at discharge.",
        },
      ],
    ]);
  });

  it("reads the practice's steps as a walk, every step with something to do", () => {
    const steps = readmeSteps("As the practice");

    expect(steps).toHaveLength(6);
    expect(steps[4]?.actions).toEqual([
      { kind: "click", name: "Confirm and charge £876.00", inDialog: false },
      { kind: "click", name: "Confirm and charge £876.00", inDialog: true },
      { kind: "see", text: "£876.00 captured. £134.00 released to Priya." },
    ]);
    expect(steps[5]?.text).toContain("fill in a patient, its species, an owner and a procedure");
    expect(steps[5]?.actions).toContainEqual({ kind: "new_case" });
    expect(steps[5]?.actions).toContainEqual({ kind: "type", field: "Clinical notes" });
  });

  it("walks neither an aside in brackets nor a step that asks nothing", () => {
    expect(stepActions("Click **A** (or click **B**).")).toEqual([
      { kind: "click", name: "A", inDialog: false },
    ]);
    expect(() => stepActions("Take a moment.")).toThrow(/asks nothing a walk can do/);
    expect(() => readmeSteps("No such section", README)).toThrow(/no section/);
  });
});
