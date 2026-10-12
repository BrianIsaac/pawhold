import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Chip, CHIP_TONES } from "../../app/components/Chip";

describe("Chip", () => {
  it("shows its label in the tone of its money state", () => {
    const html = renderToStaticMarkup(<Chip tone="held">Held £773.00</Chip>);

    expect(html).toMatch(/^<span [^>]*data-tone="held"[^>]*>Held £773.00<\/span>$/);
  });

  it("has a tone for every money state of plan 3.2 and both flags on a hold", () => {
    expect([...CHIP_TONES].sort()).toEqual(
      [
        "awaiting_owner",
        "captured",
        "estimate_draft",
        "extended",
        "held",
        "honour_period_over",
        "refunded",
        "released",
        "update_awaiting_owner",
        "update_declined",
        "withdrawn",
      ].sort(),
    );
  });
});
