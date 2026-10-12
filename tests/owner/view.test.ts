import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { appendAuditEvent } from "@/audit/writer";
import { capture } from "@/db/schema";
import { loadEstimateVersion, makeEstimateVersion } from "@/estimate/version";
import { discharge } from "@/money/discharge";
import { authoriseHold, orderHold, sendEstimate } from "@/money/holds";
import { refundCaptured } from "@/money/refunds";
import { ownerPage } from "@/owner/view";

import { connectTestDatabase } from "../support/database";
import { DENTAL_LINES, DENTAL_UPDATE_LINES, makeDentalCase } from "../support/money";
import { startPayPalDouble } from "../support/paypal-double";

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

describe("the owner's page for an update", () => {
  const { db } = connectTestDatabase();
  const paypal = startPayPalDouble();

  /**
   * A dental case held at its first estimate, with the update sent.
   *
   * @returns The case, and the first and the update's version ids.
   */
  async function heldWithUpdate() {
    const fixture = await makeDentalCase(db, "Update practice");
    const deps = { db, paypal: paypal.client() };
    const first = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });
    await sendEstimate(db, { practiceId: fixture.practiceId, versionId: first.id, actor: "vet" });
    const { hold: ordered } = await orderHold(deps, { ...fixture, versionId: first.id });
    paypal.approve(ordered.paypalOrderId, "paypal");
    await authoriseHold(deps, { ...fixture, holdId: ordered.id });
    const update = await makeEstimateVersion(db, {
      ...fixture,
      actor: "vet",
      lines: DENTAL_UPDATE_LINES,
    });
    await sendEstimate(db, { practiceId: fixture.practiceId, versionId: update.id, actor: "vet" });
    return { ...fixture, firstId: first.id, updateId: update.id };
  }

  it("is the update to answer: the explanation, the lines it adds and what it adds over the hold", async () => {
    const sent = await heldWithUpdate();
    await appendAuditEvent(db, {
      practiceId: sent.practiceId,
      caseId: sent.caseId,
      actor: "system",
      action: "estimate.update_drafted",
      model: {
        id: "gpt-6.1-sol",
        inputSha256: "a".repeat(64),
        output: { explanation: "The X-rays showed a cracked root that needs checking." },
      },
      detail: { versionId: sent.updateId },
    });

    const page = await ownerPage(db, {
      practiceId: sent.practiceId,
      caseId: sent.caseId,
      versionId: sent.updateId,
    });

    expect(page?.kind).toBe("update");
    if (page?.kind !== "update") {
      return;
    }
    expect(page.state).toBe("update_awaiting_owner");
    expect(page.explanation).toBe("The X-rays showed a cracked root that needs checking.");
    expect(page.increasePence).toBe(15_500);
    expect(page.heldPence).toBe(77_300);
    expect(page.added.map((line) => [line.wording, line.notesSpan, line.highPence])).toEqual([
      ["Dental radiographs", "rads to assess roots", 12_000],
      ["Antibiotic course", "abx to go home", 3_500],
    ]);
    expect(page.hold).toBeNull();
  });

  it("has no explanation when the update was drafted without one, or by hand", async () => {
    const sent = await heldWithUpdate();

    const page = await ownerPage(db, {
      practiceId: sent.practiceId,
      caseId: sent.caseId,
      versionId: sent.updateId,
    });

    expect(page?.kind === "update" ? page.explanation : "not an update").toBeNull();
  });

  it("is the first estimate, held, for the first version's link", async () => {
    const sent = await heldWithUpdate();

    const page = await ownerPage(db, {
      practiceId: sent.practiceId,
      caseId: sent.caseId,
      versionId: sent.firstId,
    });

    expect(page?.kind).toBe("estimate");
    expect(page?.kind === "estimate" ? page.hold?.status : null).toBe("authorised");
    expect(page?.isLatest).toBe(false);
  });
});

describe("the owner's receipt", () => {
  const { db } = connectTestDatabase();
  const paypal = startPayPalDouble();

  it("is what was paid from which approval, what was released and what was refunded, line by line", async () => {
    const fixture = await makeDentalCase(db, "Receipt practice");
    const deps = { db, paypal: paypal.client() };
    const holdFor = async (lines: typeof DENTAL_LINES) => {
      const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines });
      await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
      const { hold: ordered } = await orderHold(deps, { ...fixture, versionId: draft.id });
      paypal.approve(ordered.paypalOrderId, "card");
      await authoriseHold(deps, { ...fixture, holdId: ordered.id });
      return (await loadEstimateVersion(db, fixture.practiceId, draft.id))!;
    };
    const first = await holdFor(DENTAL_LINES);
    const update = await holdFor(DENTAL_UPDATE_LINES);
    const line = (code: string) => update.lines.find((one) => one.code === code)!.id;
    await discharge(deps, {
      ...fixture,
      actor: "vet",
      lines: ["GA-DENT", "DEN-SP", "DEN-EXT", "LAB-PRE", "XR-DENT"].map((code) => ({
        estimateLineId: line(code),
        quantity: 1,
      })),
    });
    const [captured] = await db.select().from(capture).where(eq(capture.holdId, first.id));
    await refundCaptured(deps, {
      ...fixture,
      captureId: captured!.id,
      amountPence: 2_500,
      reason: "Goodwill: the clinic ran late",
      actor: "vet",
    });

    const page = await ownerPage(db, { ...fixture, versionId: first.id });

    expect(page?.kind).toBe("receipt");
    if (page?.kind !== "receipt") {
      return;
    }
    expect(page.state).toBe("refunded");
    expect(page.chargedPence).toBe(79_500);
    expect(page.refundedPence).toBe(2_500);
    expect(page.releasedPence).toBe(13_300);
    expect(page.approvals).toEqual([
      { holdPence: 77_300, capturedPence: 67_500, releasedPence: 9_800 },
      { holdPence: 15_500, capturedPence: 12_000, releasedPence: 3_500 },
    ]);
    expect(page.lines.map((one) => [one.wording, one.quantity, one.amountPence])).toEqual([
      ["General anaesthetic for dental work", 1, 32_000],
      ["Dental scale and polish", 1, 18_500],
      ["Removing up to two damaged teeth, if needed", 1, 9_800],
      ["Pre-anaesthetic blood screen", 1, 7_200],
      ["Dental radiographs", 1, 12_000],
    ]);
  });
});
