import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent } from "@/db/schema";
import { loadDischargeView } from "@/discharge/bill";
import { confirmBill, runDischarge } from "@/discharge/confirm";
import { parsePounds, refundableCaptures, refundOnCase } from "@/discharge/refund";
import type { EstimateVersionView } from "@/estimate/version";
import { caseMoney } from "@/money/view";
import { ownerPage } from "@/owner/view";
import { PracticeError } from "@/practice/errors";
import { caseTimeline } from "@/practice/timeline";

import { connectTestDatabase } from "../support/database";
import { DENTAL_UPDATE_LINES, makeDentalCase, type MoneyFixture } from "../support/money";
import { startPayPalDouble } from "../support/paypal-double";
import { heldVersion, quantitiesOf } from "./support";

const { db } = connectTestDatabase();
const paypal = startPayPalDouble();

let fixture: MoneyFixture;
let first: EstimateVersionView;

/**
 * The money lifecycle's dependencies, on the double.
 *
 * @returns The database and the PayPal client.
 */
function deps() {
  return { db, paypal: paypal.client() };
}

/**
 * The refusal a refund meets.
 *
 * @param amount - The amount typed.
 * @param reason - The reason typed.
 * @returns The refusal.
 */
async function refused(amount: string, reason = "Goodwill"): Promise<PracticeError> {
  const [one] = await refundableCaptures(db, fixture.practiceId, fixture.caseId);
  const error = await refundOnCase(deps(), {
    ...fixture,
    captureId: one!.captureId,
    amount,
    reason,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PracticeError);
  return error as PracticeError;
}

beforeEach(async () => {
  fixture = await makeDentalCase(db);
  first = await heldVersion({ db, paypal }, fixture);
  await heldVersion({ db, paypal }, fixture, DENTAL_UPDATE_LINES);
  const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);
  await confirmBill(db, {
    ...fixture,
    quantities: quantitiesOf(view),
    extras: [],
    shown: { billedPence: 73_200 },
  });
  await runDischarge(deps(), fixture);
});

describe("a refund after discharge (plan 3.2: captured --goodwill or correction--> refunded)", () => {
  it("lists each hold's charge with what is left of it to refund", async () => {
    expect(await refundableCaptures(db, fixture.practiceId, fixture.caseId)).toEqual([
      expect.objectContaining({
        holdName: "the first hold",
        capturedPence: 57_700,
        leftPence: 57_700,
      }),
      expect.objectContaining({
        holdName: "the update's hold",
        capturedPence: 15_500,
        leftPence: 15_500,
      }),
    ]);
  });

  it("refunds part of a charge with its reason on the audit event and the timeline", async () => {
    const [one] = await refundableCaptures(db, fixture.practiceId, fixture.caseId);

    const done = await refundOnCase(deps(), {
      ...fixture,
      captureId: one!.captureId,
      amount: "£25.00",
      reason: "Goodwill: the discharge ran late",
    });

    expect(done).toMatchObject({ amountPence: 2_500, status: "completed" });
    expect(paypal.posts(/\/refund$/).map((request) => request.body)).toEqual([
      { amount: { currency_code: "GBP", value: "25.00" } },
    ]);
    const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(money).toMatchObject({ state: "refunded", refundedPence: 2_500 });
    const [asked] = await db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.caseId, fixture.caseId),
          eq(auditEvent.action, "capture.refund_requested"),
        ),
      );
    expect(asked!.detail).toMatchObject({ reason: "Goodwill: the discharge ran late" });
    const timeline = await caseTimeline(db, fixture.practiceId, fixture.caseId);
    expect(timeline.find((row) => row.action === "capture.refund_requested")!.what).toBe(
      'asked PayPal to refund £25.00: "Goodwill: the discharge ran late"',
    );
    expect((await refundableCaptures(db, fixture.practiceId, fixture.caseId))[0]!.leftPence).toBe(
      55_200,
    );
  });

  it("a refund after discharge appears on the receipt", async () => {
    const [one] = await refundableCaptures(db, fixture.practiceId, fixture.caseId);
    await refundOnCase(deps(), {
      ...fixture,
      captureId: one!.captureId,
      amount: "25",
      reason: "Goodwill",
    });

    const page = await ownerPage(db, { ...fixture, versionId: first.id });

    expect(page).toMatchObject({ kind: "receipt", chargedPence: 73_200, refundedPence: 2_500 });
  });

  it("refunds the whole of what is left of a charge", async () => {
    const [, update] = await refundableCaptures(db, fixture.practiceId, fixture.caseId);
    await refundOnCase(deps(), {
      ...fixture,
      captureId: update!.captureId,
      amount: "155.00",
      reason: "Correction: the rads were not done",
    });
    expect(await refundableCaptures(db, fixture.practiceId, fixture.caseId)).toHaveLength(1);
  });

  it("refuses an amount above what is left, a malformed amount, nothing, and no reason, field by field", async () => {
    expect((await refused("577.01")).fields).toEqual({
      amount: "At most £577.00 is left to refund from this charge.",
    });
    expect((await refused("12.345")).fields).toEqual({
      amount: "Enter an amount in pounds, as 25.00",
    });
    expect((await refused("0")).fields).toEqual({ amount: "Enter an amount above £0.00" });
    expect((await refused("10", "  ")).fields).toEqual({
      reason: "Say why: it is kept on the case's timeline.",
    });
    expect(paypal.posts(/\/refund$/)).toEqual([]);
  });

  it("refuses a capture of another case", async () => {
    const other = await makeDentalCase(db, "Another practice");
    const [one] = await refundableCaptures(db, fixture.practiceId, fixture.caseId);
    await expect(
      refundOnCase(deps(), { ...other, captureId: one!.captureId, amount: "1", reason: "x" }),
    ).rejects.toBeInstanceOf(PracticeError);
  });
});

describe("pounds as typed", () => {
  it("reads pounds and pence, with or without the sign and the thousands' commas", () => {
    expect(parsePounds("25")).toBe(2_500);
    expect(parsePounds("25.5")).toBe(2_550);
    expect(parsePounds(" £1,025.00 ")).toBe(102_500);
    expect(parsePounds("0.01")).toBe(1);
  });

  it("refuses anything else", () => {
    for (const text of ["", "abc", "1e3", "-5", "12.345", "1,00", "£", "25.00.00"]) {
      expect(parsePounds(text)).toBeNull();
    }
  });
});
