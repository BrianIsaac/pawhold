import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent, bill, capture, refund } from "@/db/schema";
import {
  type EstimateVersionView,
  loadEstimateVersion,
  makeEstimateVersion,
} from "@/estimate/version";
import {
  type BillLineInput,
  discharge,
  dischargeCase,
  planDischarge,
  resumeStalledDischarges,
  signOffBill,
} from "@/money/discharge";
import { MoneyError } from "@/money/errors";
import { authoriseHold, declineUpdate, orderHold, sendEstimate } from "@/money/holds";
import { refundCaptured } from "@/money/refunds";
import { caseMoney } from "@/money/view";
import { paypalRequestId } from "@/paypal/request-id";

import { connectTestDatabase } from "../support/database";
import {
  DENTAL_LINES,
  DENTAL_UPDATE_LINES,
  makeDentalCase,
  type MoneyFixture,
} from "../support/money";
import { startPayPalDouble } from "../support/paypal-double";
import { recordedAnswer } from "../support/recorded";

const { db } = connectTestDatabase();
const paypal = startPayPalDouble();

let fixture: MoneyFixture;

/**
 * The money lifecycle's dependencies, on the double.
 *
 * @returns The database and the PayPal client.
 */
function deps() {
  return { db, paypal: paypal.client() };
}

/**
 * Sends a version and has the owner authorise its hold.
 *
 * @param lines - The version's lines.
 * @returns The version as sent.
 */
async function held(lines = DENTAL_LINES): Promise<EstimateVersionView> {
  const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines });
  await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
  const { hold: ordered } = await orderHold(deps(), { ...fixture, versionId: draft.id });
  paypal.approve(ordered.paypalOrderId);
  await authoriseHold(deps(), { ...fixture, holdId: ordered.id });
  return (await loadEstimateVersion(db, fixture.practiceId, draft.id))!;
}

/**
 * The bill line for an estimate line by its code, at a quantity.
 *
 * @param version - The version the line is on.
 * @param code - The item's code.
 * @param quantity - The quantity done.
 * @returns The bill line.
 */
function done(version: EstimateVersionView, code: string, quantity = 1): BillLineInput {
  const line = version.lines.find((one) => one.code === code)!;
  return { estimateLineId: line.id, quantity };
}

/**
 * The reason a money operation was refused.
 *
 * @param operation - The operation.
 * @returns The refusal.
 * @throws Error when the operation succeeds.
 */
async function refusal(operation: Promise<unknown>): Promise<MoneyError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof MoneyError) {
      return error;
    }
    throw error;
  }
  throw new Error("the operation was not refused");
}

/**
 * The case's audit actions after a given event id.
 *
 * @param afterId - The last id seen.
 * @returns The events.
 */
async function eventsSince(afterId = 0) {
  return (
    await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.caseId, fixture.caseId))
      .orderBy(asc(auditEvent.id))
  ).filter((event) => event.id > afterId);
}

beforeEach(async () => {
  fixture = await makeDentalCase(db);
});

describe("discharge of a two-hold case (plan 3.2; U7's acceptance as U3 can hold it)", () => {
  let first: EstimateVersionView;
  let update: EstimateVersionView;

  beforeEach(async () => {
    first = await held();
    update = await held(DENTAL_UPDATE_LINES);
  });

  it("captures exactly the bill across both holds, final on each, and computes what is released", async () => {
    const before = (await eventsSince()).at(-1)!.id;
    const bill = [
      done(update, "GA-DENT"),
      done(update, "DEN-SP"),
      done(update, "DEN-EXT", 1),
      done(update, "LAB-PRE"),
      done(update, "XR-DENT"),
    ];

    const result = await discharge(deps(), { ...fixture, actor: "vet", lines: bill });

    expect(result).toMatchObject({
      state: "released",
      billedPence: 79_500,
      capturedPence: 79_500,
      releasedPence: 13_300,
      unpaidPence: 0,
    });
    const captures = [...paypal.captures.values()];
    expect(captures.map((one) => [one.amountPence, one.finalCapture])).toEqual([
      [67_500, true],
      [12_000, true],
    ]);
    expect(paypal.posts(/\/void$/)).toHaveLength(0);
    const actions = (await eventsSince(before)).map((event) => [
      event.action,
      event.moneyStateBefore,
      event.moneyStateAfter,
    ]);
    expect(actions).toEqual([
      ["bill.signed_off", "held", "held"],
      ["hold.captured", "held", "captured"],
      ["hold.captured", "captured", "released"],
    ]);
    const capturedEvents = (await eventsSince(before)).filter(
      (event) => event.action === "hold.captured",
    );
    for (const event of capturedEvents) {
      expect(event.paypalOrderId).toBeTruthy();
      expect(event.paypalAuthorizationId).toBeTruthy();
      expect(event.paypalCaptureId).toBeTruthy();
    }
  });

  it("shows the allocation before the vet confirms, and writes nothing", async () => {
    const plan = await planDischarge(db, {
      ...fixture,
      lines: [done(update, "GA-DENT"), done(update, "MED-AB")],
    });

    expect(
      plan.holds.map((one) => [one.versionNumber, one.capturePence, one.releasePence, one.closeBy]),
    ).toEqual([
      [1, 32_000, 45_300, "final_capture"],
      [2, 3_500, 12_000, "final_capture"],
    ]);
    expect(plan.releasedPence).toBe(57_300);
    expect(await db.select().from(capture).where(eq(capture.holdId, first.id))).toHaveLength(0);
    expect(paypal.posts(/\/capture$/)).toHaveLength(0);
    expect((await caseMoney(db, fixture.practiceId, fixture.caseId)).state).toBe("held");
  });

  it("rule 2: an update's lines are paid from the update's hold first", async () => {
    await discharge(deps(), {
      ...fixture,
      actor: "vet",
      lines: [done(update, "XR-DENT"), done(update, "MED-AB")],
    });

    const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(money.holds.map((one) => [one.versionNumber, one.status, one.capturedPence])).toEqual([
      [1, "voided", 0],
      [2, "captured", 15_500],
    ]);
  });

  it("rule 3: a hold that will not be captured again is voided at discharge", async () => {
    const result = await discharge(deps(), {
      ...fixture,
      actor: "vet",
      lines: [done(update, "GA-DENT")],
    });

    expect(paypal.posts(/\/void$/)).toHaveLength(1);
    expect(result.holds.map((one) => [one.status, one.capturedPence, one.releasedPence])).toEqual([
      ["captured", 32_000, 45_300],
      ["voided", 0, 15_500],
    ]);
    const voided = paypal.authorizations.get(result.holds[1]!.authorizationId!)!;
    expect(voided.status).toBe("VOIDED");
  });

  it("rule 3: a void is never attempted on a fully captured hold", async () => {
    const everything = update.lines.map((line) => ({
      estimateLineId: line.id,
      quantity: line.quantityHigh,
    }));

    const result = await discharge(deps(), { ...fixture, actor: "vet", lines: everything });

    expect(result).toMatchObject({ state: "captured", capturedPence: 92_800, releasedPence: 0 });
    expect(paypal.posts(/\/void$/)).toHaveLength(0);
  });

  it("rule 1: a bill above the holds cannot be signed off; nothing is captured", async () => {
    const above = [
      ...update.lines.map((line) => ({ estimateLineId: line.id, quantity: line.quantityHigh })),
    ];
    above[2] = { ...above[2]!, quantity: 3 };

    const refused = await refusal(discharge(deps(), { ...fixture, actor: "vet", lines: above }));

    expect(refused.reason).toBe("bill_refused");
    expect(paypal.posts(/\/capture$/)).toHaveLength(0);
  });

  it("rule 4: every PayPal POST of the discharge carries a request id derived from the case, the hold and the step", async () => {
    await discharge(deps(), { ...fixture, actor: "vet", lines: [done(update, "GA-DENT")] });

    const [captured] = paypal.posts(/\/capture$/);
    const [voided] = paypal.posts(/\/void$/);
    expect(captured!.headers["paypal-request-id"]).toBe(
      paypalRequestId({ caseId: fixture.caseId, holdId: first.id, step: "capture.1" }),
    );
    expect(voided!.headers["paypal-request-id"]).toBe(
      paypalRequestId({ caseId: fixture.caseId, holdId: update.id, step: "void" }),
    );
    for (const post of paypal.requests.filter((request) => request.method === "POST")) {
      if (post.path !== "/v1/oauth2/token") {
        expect(post.headers["paypal-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      }
    }
  });

  it("rule 4: a capture whose answer was lost is retried with the same request id and captures once", async () => {
    paypal.inject({ method: "POST", path: /\/capture$/, status: 500, body: null, acts: true });

    const lost = await refusal(
      discharge(deps(), { ...fixture, actor: "vet", lines: [done(update, "GA-DENT")] }),
    );
    expect(lost.reason).toBe("paypal_unavailable");
    expect((await caseMoney(db, fixture.practiceId, fixture.caseId)).state).toBe("held");

    const resumed = await dischargeCase(deps(), fixture);

    expect(paypal.captures.size).toBe(1);
    const [once, again] = paypal.posts(/\/capture$/);
    expect(again!.headers["paypal-request-id"]).toBe(once!.headers["paypal-request-id"]);
    expect(resumed).toMatchObject({ state: "released", capturedPence: 32_000 });
    expect(await db.select().from(capture).where(eq(capture.holdId, first.id))).toHaveLength(1);
  });

  it("flags the hold when PayPal answers its capture in a status it does not list, and records no capture", async () => {
    // A synthetic answer: P2's recorded capture in a status outside PayPal's published list.
    paypal.inject({
      method: "POST",
      path: /\/capture$/,
      status: 201,
      body: {
        ...(recordedAnswer("P2", "POST", /\/capture$/).responseBody as object),
        id: "2GG27936SYNTHCAP1",
        status: "COMPLETED_LATER",
      },
      acts: true,
    });
    const before = (await eventsSince()).at(-1)!.id;

    const stopped = await refusal(
      discharge(deps(), { ...fixture, actor: "vet", lines: [done(update, "GA-DENT")] }),
    );

    expect(stopped.reason).toBe("paypal_unavailable");
    expect(stopped.message).toContain("COMPLETED_LATER");
    expect(await db.select().from(capture).where(eq(capture.holdId, first.id))).toHaveLength(0);
    expect((await caseMoney(db, fixture.practiceId, fixture.caseId)).state).toBe("held");
    const flagged = (await eventsSince(before)).filter(
      (event) => event.action === "hold.paypal_status_unknown",
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({
      actor: "system",
      paypalAuthorizationId: expect.any(String),
      paypalCaptureId: "2GG27936SYNTHCAP1",
      detail: { holdId: first.id, step: "capture", status: "COMPLETED_LATER" },
    });
  });

  it("records an expired hold, leaves its share unpaid, and still closes the others", async () => {
    paypal.inject({
      method: "POST",
      path: /\/capture$/,
      status: 422,
      body: recordedAnswer("P5A", "POST", /\/capture$/).responseBody,
    });

    const result = await discharge(deps(), {
      ...fixture,
      actor: "vet",
      lines: [done(update, "GA-DENT"), done(update, "XR-DENT")],
    });

    expect(result.holds.map((one) => one.status)).toEqual(["expired", "captured"]);
    expect(result).toMatchObject({ capturedPence: 12_000, unpaidPence: 32_000 });
    const expired = (await eventsSince()).find((event) => event.action === "hold.expired");
    expect(expired).toMatchObject({ paypalDebugId: "70c28ae654da" });
  });
});

describe("discharge's edges (the review of 12 October 2026)", () => {
  it("refuses to send an update once the bill is signed off", async () => {
    const first = await held();
    await signOffBill(db, { ...fixture, actor: "vet", lines: [done(first, "GA-DENT")] });
    const draft = await makeEstimateVersion(db, {
      ...fixture,
      actor: "vet",
      lines: DENTAL_UPDATE_LINES,
    });

    const refused = await refusal(
      sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" }),
    );

    expect(refused.reason).toBe("wrong_state");
    expect(refused.message).toContain("signed off");
  });

  it("two discharges at once capture once and write one event per step", async () => {
    const first = await held();
    const update = await held(DENTAL_UPDATE_LINES);
    await signOffBill(db, { ...fixture, actor: "vet", lines: [done(update, "GA-DENT")] });

    const results = await Promise.allSettled([
      dischargeCase(deps(), fixture),
      dischargeCase(deps(), fixture),
    ]);

    expect(results.some((one) => one.status === "fulfilled")).toBe(true);
    await dischargeCase(deps(), fixture);
    expect(paypal.captures.size).toBe(1);
    const actions = (await eventsSince()).map((event) => event.action);
    expect(actions.filter((action) => action === "hold.captured")).toHaveLength(1);
    expect(actions.filter((action) => action === "hold.voided")).toHaveLength(1);
    expect((await caseMoney(db, fixture.practiceId, fixture.caseId)).holds[0]!.id).toBe(first.id);
  });

  it("resumes, hourly, a discharge stopped after its sign-off", async () => {
    const first = await held();
    paypal.inject({ method: "POST", path: /\/capture$/, status: 503, body: null });
    await refusal(discharge(deps(), { ...fixture, actor: "vet", lines: [done(first, "GA-DENT")] }));
    const [signed] = await db.select().from(bill).where(eq(bill.caseId, fixture.caseId));

    const soon = await resumeStalledDischarges({
      ...deps(),
      now: new Date(signed!.signedOffAt.getTime() + 60 * 1000),
      practiceId: fixture.practiceId,
    });
    const later = await resumeStalledDischarges({
      ...deps(),
      now: new Date(signed!.signedOffAt.getTime() + 11 * 60 * 1000),
      practiceId: fixture.practiceId,
    });

    expect(soon.resumed).toEqual([]);
    expect(later.resumed).toEqual([fixture.caseId]);
    expect((await caseMoney(db, fixture.practiceId, fixture.caseId)).state).toBe("released");
  });
});

describe("rule 6 and D17: nothing is captured that is not on a bill line the vet signed off", () => {
  it("refuses to discharge a case with no signed-off bill: no capture before discharge", async () => {
    await held();

    const refused = await refusal(dischargeCase(deps(), fixture));

    expect(refused.reason).toBe("bill_refused");
    expect(paypal.posts(/\/capture$/)).toHaveLength(0);
  });

  it("refuses a line not on the approved estimate: an update declined freezes scope at what is held", async () => {
    const first = await held();
    const draft = await makeEstimateVersion(db, {
      ...fixture,
      actor: "vet",
      lines: DENTAL_UPDATE_LINES,
    });
    await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
    await declineUpdate(db, { ...fixture, actor: "owner" });

    const refused = await refusal(
      signOffBill(db, {
        ...fixture,
        actor: "vet",
        lines: [done(first, "GA-DENT"), done(draft, "XR-DENT")],
      }),
    );

    expect(refused.reason).toBe("bill_refused");
    expect(refused.message).toContain("Not on an approved estimate. Send an update to charge it.");

    const result = await discharge(deps(), {
      ...fixture,
      actor: "vet",
      lines: [done(first, "GA-DENT")],
    });
    expect(result).toMatchObject({
      state: "released",
      capturedPence: 32_000,
      releasedPence: 45_300,
    });
  });

  it("refuses a quantity above the one approved", async () => {
    const first = await held();

    const refused = await refusal(
      signOffBill(db, { ...fixture, actor: "vet", lines: [done(first, "DEN-EXT", 3)] }),
    );

    expect(refused.reason).toBe("bill_refused");
    expect(refused.message).toContain("2 approved");
  });

  it("refuses to sign off twice", async () => {
    const first = await held();
    await signOffBill(db, { ...fixture, actor: "vet", lines: [done(first, "GA-DENT")] });

    const refused = await refusal(
      signOffBill(db, { ...fixture, actor: "vet", lines: [done(first, "GA-DENT")] }),
    );

    expect(refused.reason).toBe("bill_refused");
  });

  it("refuses to sign off while an update awaits the owner", async () => {
    const first = await held();
    const draft = await makeEstimateVersion(db, {
      ...fixture,
      actor: "vet",
      lines: DENTAL_UPDATE_LINES,
    });
    await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });

    const refused = await refusal(
      signOffBill(db, { ...fixture, actor: "vet", lines: [done(first, "GA-DENT")] }),
    );

    expect(refused.reason).toBe("wrong_state");
  });

  it("discharges a bill of nothing done by voiding every hold", async () => {
    await held();

    const result = await discharge(deps(), { ...fixture, actor: "vet", lines: [] });

    expect(result).toMatchObject({ state: "released", capturedPence: 0, releasedPence: 77_300 });
    expect(paypal.posts(/\/capture$/)).toHaveLength(0);
  });
});

describe("refunded (plan 3.2: captured --goodwill or correction--> refunded, part or whole)", () => {
  let capturedId: string;

  beforeEach(async () => {
    const first = await held();
    await discharge(deps(), {
      ...fixture,
      actor: "vet",
      lines: [done(first, "GA-DENT"), done(first, "DEN-SP")],
    });
    const [taken] = await db.select().from(capture).where(eq(capture.holdId, first.id));
    capturedId = taken!.id;
  });

  it("refunds part of a capture, then the rest, each with its own request id", async () => {
    const part = await refundCaptured(deps(), {
      ...fixture,
      captureId: capturedId,
      amountPence: 5_000,
      reason: "goodwill: the scale and polish took less time",
      actor: "vet",
    });
    const rest = await refundCaptured(deps(), {
      ...fixture,
      captureId: capturedId,
      reason: "correction",
      actor: "vet",
    });

    expect(part).toMatchObject({ amountPence: 5_000, status: "completed" });
    expect(rest).toMatchObject({ amountPence: 45_500, status: "completed" });
    const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(money).toMatchObject({ state: "refunded", refundedPence: 50_500 });
    const posts = paypal.posts(/\/refund$/);
    expect(posts.map((post) => post.body)).toEqual([
      { amount: { currency_code: "GBP", value: "50.00" } },
      { amount: { currency_code: "GBP", value: "455.00" } },
    ]);
    expect(new Set(posts.map((post) => post.headers["paypal-request-id"])).size).toBe(2);
    const [taken] = await db.select().from(capture).where(eq(capture.id, capturedId));
    expect(taken!.status).toBe("refunded");
    const actions = (await eventsSince()).map((event) => event.action).slice(-4);
    expect(actions).toEqual([
      "capture.refund_requested",
      "capture.refunded",
      "capture.refund_requested",
      "capture.refunded",
    ]);
  });

  it("refuses a refund above what is left of the capture, and asks PayPal nothing", async () => {
    const refused = await refusal(
      refundCaptured(deps(), {
        ...fixture,
        captureId: capturedId,
        amountPence: 50_501,
        reason: "too much",
        actor: "vet",
      }),
    );

    expect(refused.reason).toBe("refund_refused");
    expect(paypal.posts(/\/refund$/)).toHaveLength(0);
    expect(await db.select().from(refund).where(eq(refund.captureId, capturedId))).toHaveLength(0);
  });

  it("flags the hold when PayPal answers a refund in a status it does not list, and leaves the refund asked", async () => {
    // A synthetic answer: no recording holds a refund, nor a status outside PayPal's published list.
    paypal.inject({
      method: "POST",
      path: /\/refund$/,
      status: 201,
      body: { id: "1JU08902SYNTHREF1", status: "COMPLETED_LATER", links: [] },
      acts: true,
    });
    const before = (await eventsSince()).at(-1)!.id;

    const stopped = await refusal(
      refundCaptured(deps(), {
        ...fixture,
        captureId: capturedId,
        amountPence: 2_000,
        reason: "goodwill",
        actor: "vet",
      }),
    );

    expect(stopped.reason).toBe("paypal_unavailable");
    expect(stopped.message).toContain("COMPLETED_LATER");
    const [asked] = await db.select().from(refund).where(eq(refund.captureId, capturedId));
    expect(asked).toMatchObject({ status: "requested", paypalRefundId: null });
    const [taken] = await db.select().from(capture).where(eq(capture.id, capturedId));
    expect(taken!.status).toBe("completed");
    const flagged = (await eventsSince(before)).filter(
      (event) => event.action === "hold.paypal_status_unknown",
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({
      actor: "system",
      paypalCaptureId: taken!.paypalCaptureId,
      paypalRefundId: "1JU08902SYNTHREF1",
      detail: { holdId: taken!.holdId, step: "refund", status: "COMPLETED_LATER" },
    });
  });

  it("resumes a refund whose answer was lost with the same request id and the same amount", async () => {
    paypal.inject({ method: "POST", path: /\/refund$/, status: 503, body: null, acts: true });
    await refusal(
      refundCaptured(deps(), {
        ...fixture,
        captureId: capturedId,
        amountPence: 2_000,
        reason: "goodwill",
        actor: "vet",
      }),
    );

    const resumed = await refundCaptured(deps(), {
      ...fixture,
      captureId: capturedId,
      amountPence: 2_000,
      reason: "goodwill",
      actor: "vet",
    });

    expect(resumed.status).toBe("completed");
    const [once, again] = paypal.posts(/\/refund$/);
    expect(again!.headers["paypal-request-id"]).toBe(once!.headers["paypal-request-id"]);
    expect(paypal.captures.get(resumed.paypalCaptureId)!.refundedPence).toBe(2_000);
  });
});
