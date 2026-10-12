import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent, patientCase, practice } from "@/db/schema";
import { importPriceList } from "@/estimate/price-list";
import {
  checkEstimateTrigger,
  checkUpdateTrigger,
  DEFAULT_MONETARY_THRESHOLD_PENCE,
  monetaryThreshold,
  setMonetaryThreshold,
} from "@/estimate/trigger";
import { EstimateError, makeEstimateVersion, sendEstimateVersion } from "@/estimate/version";

import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();

const POUNDS = 100;
const THRESHOLD = 500 * POUNDS;

describe('the update trigger: "by 20% or by an amount equal to the Monetary Threshold, whichever is lower" (Art. 11)', () => {
  it("19.9% under £500 does not meet it", () => {
    const check = checkUpdateTrigger({
      originalPence: 1_000 * POUNDS,
      revisedPence: 1_199 * POUNDS,
      thresholdPence: THRESHOLD,
    });

    expect(check.increasePence).toBe(199 * POUNDS);
    expect(check.increaseBasisPoints).toBe(1_990);
    expect(check.met).toBe(false);
  });

  it("20% does", () => {
    const check = checkUpdateTrigger({
      originalPence: 1_000 * POUNDS,
      revisedPence: 1_200 * POUNDS,
      thresholdPence: THRESHOLD,
    });

    expect(check.increaseBasisPoints).toBe(2_000);
    expect(check.met).toBe(true);
  });

  it("£500.01 does even under 20%", () => {
    const check = checkUpdateTrigger({
      originalPence: 5_000 * POUNDS,
      revisedPence: 5_000 * POUNDS + 50_001,
      thresholdPence: THRESHOLD,
    });

    expect(check.increasePence).toBe(50_001);
    expect(check.increaseBasisPoints).toBe(1_000);
    expect(check.met).toBe(true);
  });

  it("meets it at an amount equal to the threshold, as the Order words it", () => {
    expect(
      checkUpdateTrigger({
        originalPence: 5_000 * POUNDS,
        revisedPence: 5_500 * POUNDS,
        thresholdPence: THRESHOLD,
      }).met,
    ).toBe(true);
    expect(
      checkUpdateTrigger({
        originalPence: 5_000 * POUNDS,
        revisedPence: 5_500 * POUNDS - 1,
        thresholdPence: THRESHOLD,
      }).met,
    ).toBe(false);
  });

  it("takes whichever is lower: 20% of a small estimate, the threshold on a large one", () => {
    expect(
      checkUpdateTrigger({
        originalPence: 400 * POUNDS,
        revisedPence: 480 * POUNDS,
        thresholdPence: THRESHOLD,
      }),
    ).toMatchObject({ triggerPence: 80 * POUNDS, met: true });
    expect(
      checkUpdateTrigger({
        originalPence: 9_000 * POUNDS,
        revisedPence: 9_400 * POUNDS,
        thresholdPence: THRESHOLD,
      }),
    ).toMatchObject({ triggerPence: THRESHOLD, met: false });
  });

  it("counts 20% to the penny, with no rounding in the estimate's favour", () => {
    expect(
      checkUpdateTrigger({
        originalPence: 100_001,
        revisedPence: 120_001,
        thresholdPence: THRESHOLD,
      }),
    ).toMatchObject({ triggerPence: 20_001, met: false });
    expect(
      checkUpdateTrigger({
        originalPence: 100_001,
        revisedPence: 120_002,
        thresholdPence: THRESHOLD,
      }),
    ).toMatchObject({ triggerPence: 20_001, met: true });
  });

  it("is not met by a decrease, nor by no change", () => {
    expect(
      checkUpdateTrigger({
        originalPence: 1_000 * POUNDS,
        revisedPence: 600 * POUNDS,
        thresholdPence: THRESHOLD,
      }),
    ).toMatchObject({ increasePence: -400 * POUNDS, met: false });
    expect(
      checkUpdateTrigger({ originalPence: 0, revisedPence: 0, thresholdPence: THRESHOLD }),
    ).toMatchObject({ increaseBasisPoints: null, met: false });
  });

  it("follows the practice's own threshold", () => {
    const check = checkUpdateTrigger({
      originalPence: 5_000 * POUNDS,
      revisedPence: 5_300 * POUNDS,
      thresholdPence: 300 * POUNDS,
    });

    expect(check).toMatchObject({ triggerPence: 300 * POUNDS, met: true });
  });

  it("refuses money that is not whole, non-negative pence", () => {
    expect(() =>
      checkUpdateTrigger({ originalPence: 100.5, revisedPence: 200, thresholdPence: THRESHOLD }),
    ).toThrow(EstimateError);
    expect(() =>
      checkUpdateTrigger({ originalPence: 100, revisedPence: 200, thresholdPence: 0 }),
    ).toThrow(EstimateError);
  });
});

describe("the threshold as a practice setting", () => {
  let practiceId: string;

  beforeEach(async () => {
    const [made] = await db
      .insert(practice)
      .values({ name: "Threshold practice", kind: "judge" })
      .returning();
    practiceId = made!.id;
  });

  it("defaults to £500 including VAT", async () => {
    expect(DEFAULT_MONETARY_THRESHOLD_PENCE).toBe(THRESHOLD);
    expect(await monetaryThreshold(db, practiceId)).toBe(THRESHOLD);
  });

  it("is changed by the practice and the change recorded", async () => {
    await setMonetaryThreshold(db, { practiceId, pence: 300 * POUNDS, actor: "vet" });

    expect(await monetaryThreshold(db, practiceId)).toBe(300 * POUNDS);
    const [event] = await db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.practiceId, practiceId),
          eq(auditEvent.action, "practice.threshold_changed"),
        ),
      );
    expect(event).toMatchObject({ actor: "vet", amountPence: 300 * POUNDS, currencyCode: "GBP" });
    expect(event!.detail).toEqual({ beforePence: THRESHOLD, afterPence: 300 * POUNDS });
  });

  it("refuses a threshold of nothing", async () => {
    await expect(
      setMonetaryThreshold(db, { practiceId, pence: 0, actor: "vet" }),
    ).rejects.toBeInstanceOf(EstimateError);
  });
});

describe("the trigger on a case's versions", () => {
  const PRICES = [
    "code,name,category,unit,unit_price_pence",
    "SURG-FB,Foreign body removal from the gut,procedure,procedure,120000",
    "HOSP-DAY,Hospitalisation,hospitalisation,day,9500",
    "IMG-US,Ultrasound scan,imaging,scan,25000",
  ].join("\n");

  let practiceId: string;
  let caseId: string;

  beforeEach(async () => {
    const [made] = await db
      .insert(practice)
      .values({ name: "Case trigger practice", kind: "judge" })
      .returning();
    practiceId = made!.id;
    await importPriceList(db, { practiceId, actor: "system", sourceName: "p.csv", csv: PRICES });
    const [kase] = await db
      .insert(patientCase)
      .values({ practiceId, patientName: "Pip", ownerName: "C. Owner", procedure: "Laparotomy" })
      .returning();
    caseId = kase!.id;
  });

  it("measures each version from the original written estimate's top, against the practice's threshold", async () => {
    const original = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [
        { code: "SURG-FB", quantityLow: 1, quantityHigh: 1 },
        { code: "HOSP-DAY", quantityLow: 1, quantityHigh: 2 },
      ],
    });
    await sendEstimateVersion(db, { practiceId, versionId: original.id, actor: "vet" });
    const second = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [
        { code: "SURG-FB", quantityLow: 1, quantityHigh: 1 },
        { code: "HOSP-DAY", quantityLow: 2, quantityHigh: 3 },
      ],
    });
    await sendEstimateVersion(db, { practiceId, versionId: second.id, actor: "vet" });
    const third = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [
        { code: "SURG-FB", quantityLow: 1, quantityHigh: 1 },
        { code: "HOSP-DAY", quantityLow: 2, quantityHigh: 4 },
        { code: "IMG-US", quantityLow: 1, quantityHigh: 1 },
      ],
    });

    const atSecond = await checkEstimateTrigger(db, { practiceId, versionId: second.id });
    const atThird = await checkEstimateTrigger(db, { practiceId, versionId: third.id });

    expect(atSecond).toMatchObject({
      original: { versionId: original.id, number: 1 },
      originalPence: 139_000,
      revisedPence: 148_500,
      increasePence: 9_500,
      met: false,
    });
    expect(atThird).toMatchObject({
      original: { versionId: original.id, number: 1 },
      revisedPence: 183_000,
      increasePence: 44_000,
      triggerPence: 27_800,
      met: true,
    });
  });

  it("has nothing to measure for the original itself", async () => {
    const original = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [{ code: "SURG-FB", quantityLow: 1, quantityHigh: 1 }],
    });

    expect(await checkEstimateTrigger(db, { practiceId, versionId: original.id })).toBeNull();
    await sendEstimateVersion(db, { practiceId, versionId: original.id, actor: "vet" });
    expect(await checkEstimateTrigger(db, { practiceId, versionId: original.id })).toBeNull();
  });
});

describe("a trigger request", () => {
  it("is refused with a typed refusal when malformed", async () => {
    await expect(
      checkEstimateTrigger(db, { practiceId: "not-a-uuid", versionId: "nor-this" }),
    ).rejects.toMatchObject({ name: "EstimateError", reason: "request_invalid" });
  });
});
