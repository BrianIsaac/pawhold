import { asc, eq, gt, and } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent, capture } from "@/db/schema";
import { type BillReviewRequest, loadDischargeView } from "@/discharge/bill";
import { confirmBill, runDischarge } from "@/discharge/confirm";
import { dischargeProgress, STALL_AFTER_MS } from "@/discharge/progress";
import { SEEDED_HOLDS } from "@/discharge/wording";
import { MoneyError } from "@/money/errors";
import { reconcileWebhookEvent } from "@/money/reconcile";
import { caseMoney } from "@/money/view";
import { PracticeError } from "@/practice/errors";

import { connectTestDatabase } from "../support/database";
import { DENTAL_UPDATE_LINES, makeDentalCase, type MoneyFixture } from "../support/money";
import { startPayPalDouble } from "../support/paypal-double";
import { storeDelivery } from "../support/webhook-delivery";
import { heldVersion, quantitiesOf, seededHeldVersion } from "./support";

const { db } = connectTestDatabase();
const paypal = startPayPalDouble();

let fixture: MoneyFixture;

beforeEach(async () => {
  fixture = await makeDentalCase(db);
});

/**
 * The money lifecycle's dependencies, on the double.
 *
 * @returns The database and the PayPal client.
 */
function deps() {
  return { db, paypal: paypal.client() };
}

/**
 * The bill as the page would send it: each line at its low, some changed.
 *
 * @param changes - Quantities by item code.
 * @param extras - Work not on the estimate.
 * @returns The request's quantities and extras.
 */
async function billOf(
  changes: Record<string, string> = {},
  extras: BillReviewRequest["extras"] = [],
): Promise<Pick<BillReviewRequest, "quantities" | "extras">> {
  const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);
  const quantities = quantitiesOf(view);
  for (const line of view.groups.flatMap((group) => group.lines)) {
    if (changes[line.code] !== undefined) {
      quantities[line.estimateLineId] = changes[line.code]!;
    }
  }
  return { quantities, extras };
}

/**
 * The case's audit actions after an event id.
 *
 * @param afterId - The last id seen.
 * @returns The actions, in order.
 */
async function actionsSince(afterId: number): Promise<string[]> {
  const rows = await db
    .select({ action: auditEvent.action })
    .from(auditEvent)
    .where(and(eq(auditEvent.caseId, fixture.caseId), gt(auditEvent.id, afterId)))
    .orderBy(asc(auditEvent.id));
  return rows.map((row) => row.action);
}

/**
 * The id of the case's last audit event.
 *
 * @returns The id.
 */
async function lastEventId(): Promise<number> {
  const rows = await db
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(eq(auditEvent.caseId, fixture.caseId))
    .orderBy(asc(auditEvent.id));
  return rows.at(-1)!.id;
}

describe("confirm and charge (U7's acceptance)", () => {
  it("a seeded two-hold case discharges to the exact bill across both holds with the remainder released, the audit events and the webhooks in order", async () => {
    await heldVersion({ db, paypal }, fixture);
    await heldVersion({ db, paypal }, fixture, DENTAL_UPDATE_LINES);
    const before = await lastEventId();
    // GA £320, scale £185, one extraction £98, bloods £72 from the first hold;
    // rads £120 and antibiotics £35 from the update's.
    const bill = await billOf({ "DEN-EXT": "1" }, [{ code: "CON-STD", quantity: "1" }]);

    const plan = await confirmBill(db, {
      ...fixture,
      ...bill,
      shown: { billedPence: 83_000 },
    });
    expect(plan.holds.map((one) => [one.capturePence, one.releasePence])).toEqual([
      [67_500, 9_800],
      [15_500, 0],
    ]);
    await runDischarge(deps(), fixture);

    expect(
      paypal.posts(/\/capture$/).map((request) => request.body as Record<string, unknown>),
    ).toEqual([
      { amount: { currency_code: "GBP", value: "675.00" }, final_capture: true },
      { amount: { currency_code: "GBP", value: "155.00" }, final_capture: true },
    ]);
    expect(paypal.posts(/\/void$/)).toEqual([]);
    const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(money).toMatchObject({ state: "released", capturedPence: 83_000, releasedPence: 9_800 });
    expect([...paypal.authorizations.values()].map((one) => one.status)).toEqual([
      "CAPTURED",
      "CAPTURED",
    ]);

    const captures = await db.select().from(capture).orderBy(asc(capture.capturedAt));
    const ours = captures.filter((one) => money.holds.some((held) => held.id === one.holdId));
    for (const taken of ours.sort((a, b) =>
      money.holds.findIndex((held) => held.id === a.holdId) <
      money.holds.findIndex((held) => held.id === b.holdId)
        ? -1
        : 1,
    )) {
      const eventId = await storeDelivery(db, "PAYMENT.CAPTURE.COMPLETED", taken.paypalCaptureId);
      expect(await reconcileWebhookEvent(db, eventId)).toEqual({ outcome: "reconciled" });
    }

    expect(await actionsSince(before)).toEqual([
      "bill.signed_off",
      "bill.work_not_charged",
      "hold.captured",
      "hold.captured",
      "webhook.reconciled",
      "webhook.reconciled",
    ]);
    const progress = (await dischargeProgress(db, fixture.practiceId, fixture.caseId))!;
    expect(progress).toMatchObject({
      billedPence: 83_000,
      capturedPence: 83_000,
      releasedPence: 9_800,
      finished: true,
      confirmed: true,
      stalled: false,
    });
    expect(progress.holds.map((one) => [one.name, one.capture?.pence, one.release?.pence])).toEqual(
      [
        ["The first hold", 67_500, 9_800],
        ["The update's hold", 15_500, undefined],
      ],
    );
    expect(progress.holds.every((one) => one.capture?.confirmedAt instanceof Date)).toBe(true);
    expect(progress.holds[0]!.release!.confirmedAt).toEqual(
      progress.holds[0]!.capture!.confirmedAt,
    );
    expect(progress.work).toEqual([
      expect.objectContaining({ code: "CON-STD", quantity: 1, amountPence: 4_800 }),
    ]);
  });

  it("voids the update's hold when the bill takes nothing from it, and the void's webhook confirms the release", async () => {
    await heldVersion({ db, paypal }, fixture);
    await heldVersion({ db, paypal }, fixture, DENTAL_UPDATE_LINES);
    const bill = await billOf({ "XR-DENT": "0", "MED-AB": "0" });

    await confirmBill(db, { ...fixture, ...bill, shown: { billedPence: 57_700 } });
    await runDischarge(deps(), fixture);

    expect(paypal.posts(/\/capture$/)).toHaveLength(1);
    expect(paypal.posts(/\/void$/)).toHaveLength(1);
    const voided = [...paypal.authorizations.values()].find((one) => one.status === "VOIDED")!;
    let progress = (await dischargeProgress(db, fixture.practiceId, fixture.caseId))!;
    expect(progress.holds[1]).toMatchObject({
      capture: null,
      release: { pence: 15_500, confirmedAt: null },
    });
    expect(progress.confirmed).toBe(false);

    const eventId = await storeDelivery(db, "PAYMENT.AUTHORIZATION.VOIDED", voided.id);
    await reconcileWebhookEvent(db, eventId);

    progress = (await dischargeProgress(db, fixture.practiceId, fixture.caseId))!;
    expect(progress.holds[1]!.release!.confirmedAt).toBeInstanceOf(Date);
  });

  it("a discharge stopped part way shows as stalled, and resumes to the end without capturing twice", async () => {
    await heldVersion({ db, paypal }, fixture);
    await heldVersion({ db, paypal }, fixture, DENTAL_UPDATE_LINES);
    const bill = await billOf();
    await confirmBill(db, { ...fixture, ...bill, shown: { billedPence: 73_200 } });
    paypal.inject({
      method: "POST",
      path: /\/capture$/,
      status: 503,
      body: { name: "SERVICE_UNAVAILABLE" },
    });

    await expect(runDischarge(deps(), fixture)).rejects.toMatchObject({
      reason: "paypal_unavailable",
    });
    const signedOff = (await dischargeProgress(db, fixture.practiceId, fixture.caseId))!
      .signedOffAt;
    const soon = await dischargeProgress(db, fixture.practiceId, fixture.caseId, signedOff);
    expect(soon).toMatchObject({ finished: false, stalled: false });
    const later = await dischargeProgress(
      db,
      fixture.practiceId,
      fixture.caseId,
      new Date(signedOff.getTime() + STALL_AFTER_MS),
    );
    expect(later).toMatchObject({ finished: false, stalled: true });

    await runDischarge(deps(), fixture);

    expect(paypal.posts(/\/capture$/).length).toBe(3);
    expect([...paypal.captures.values()]).toHaveLength(2);
    expect(await dischargeProgress(db, fixture.practiceId, fixture.caseId)).toMatchObject({
      finished: true,
      capturedPence: 73_200,
      releasedPence: 19_600,
    });
  });

  it("shows PayPal's refusal on the hold it refused, as a stall to resume", async () => {
    await heldVersion({ db, paypal }, fixture);
    await confirmBill(db, { ...fixture, ...(await billOf()), shown: { billedPence: 57_700 } });
    paypal.inject({
      method: "POST",
      path: /\/capture$/,
      status: 422,
      body: {
        name: "UNPROCESSABLE_ENTITY",
        debug_id: "double422",
        details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument was declined." }],
      },
    });

    await expect(runDischarge(deps(), fixture)).rejects.toBeInstanceOf(MoneyError);

    const progress = (await dischargeProgress(db, fixture.practiceId, fixture.caseId))!;
    expect(progress.stalled).toBe(true);
    expect(progress.holds[0]!.refused).toBe(true);
  });
});

describe("what confirm refuses", () => {
  it("a bill changed since it was shown", async () => {
    await heldVersion({ db, paypal }, fixture);
    await expect(
      confirmBill(db, { ...fixture, ...(await billOf()), shown: { billedPence: 50_000 } }),
    ).rejects.toMatchObject({ reason: "stale" });
    expect(await dischargeProgress(db, fixture.practiceId, fixture.caseId)).toBeNull();
  });

  it("a bill above the holds, with its reason", async () => {
    await heldVersion({ db, paypal }, fixture);
    const refusal = await confirmBill(db, {
      ...fixture,
      ...(await billOf({ "DEN-EXT": "5" })),
      shown: { billedPence: 106_700 },
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PracticeError);
    expect((refusal as PracticeError).message).toMatch(
      /^The bill is £1,067.00, above the £773.00 held/,
    );
    expect(paypal.posts(/capture|void/)).toEqual([]);
  });

  it("holds seeded for the demo, which PayPal would refuse", async () => {
    await seededHeldVersion(db, fixture);
    const refusal = await confirmBill(db, {
      ...fixture,
      ...(await billOf()),
      shown: { billedPence: 57_700 },
    }).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ message: SEEDED_HOLDS });
    await expect(runDischarge(deps(), fixture)).rejects.toMatchObject({ message: SEEDED_HOLDS });
    expect(paypal.requests).toEqual([]);
  });

  it("a second confirm of a bill signed off already", async () => {
    await heldVersion({ db, paypal }, fixture);
    const bill = await billOf();
    await confirmBill(db, { ...fixture, ...bill, shown: { billedPence: 57_700 } });
    await expect(
      confirmBill(db, { ...fixture, ...bill, shown: { billedPence: 57_700 } }),
    ).rejects.toMatchObject({ reason: "stale" });
  });
});
