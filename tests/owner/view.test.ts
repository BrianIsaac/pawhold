import { describe, expect, it } from "vitest";

import { makeEstimateVersion } from "@/estimate/version";
import { sendEstimate } from "@/money/holds";
import { ownerPage } from "@/owner/view";

import { connectTestDatabase } from "../support/database";
import { DENTAL_LINES, makeDentalCase } from "../support/money";

describe("the owner's page for a link", () => {
  const { db } = connectTestDatabase();

  it("is the estimate to authorise while the first estimate awaits the owner", async () => {
    const fixture = await makeDentalCase(db, "View practice");
    const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });
    await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });

    const page = await ownerPage(db, { ...fixture, versionId: draft.id });

    expect(page?.kind).toBe("estimate");
    if (page?.kind !== "estimate") {
      return;
    }
    expect(page.header).toEqual({
      practiceName: "View practice",
      patientName: "Biscuit",
      ownerName: "Ann Owner",
    });
    expect(page.currency).toBe("GBP");
    expect(page.totals).toEqual({ lowPence: 57_700, highPence: 77_300 });
    expect(page.holdPence).toBe(77_300);
    expect(page.lines).toEqual([
      {
        position: 1,
        wording: "General anaesthetic for dental work",
        notesSpan: "GA",
        dependsOn: null,
        lowPence: 32_000,
        highPence: 32_000,
      },
      {
        position: 2,
        wording: "Dental scale and polish",
        notesSpan: "dental scale and polish",
        dependsOn: null,
        lowPence: 18_500,
        highPence: 18_500,
      },
      {
        position: 3,
        wording: "Removing up to two damaged teeth, if needed",
        notesSpan: "probable two extractions upper PM",
        dependsOn: "only if extractions are needed",
        lowPence: 0,
        highPence: 19_600,
      },
      {
        position: 4,
        wording: "Pre-anaesthetic blood screen",
        notesSpan: "pre-op bloods",
        dependsOn: null,
        lowPence: 7_200,
        highPence: 7_200,
      },
    ]);
  });
});
