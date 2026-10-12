import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent, hold, patientCase } from "@/db/schema";
import { loadEstimateVersion, makeEstimateVersion } from "@/estimate/version";
import { reauthoriseHolds } from "@/jobs/reauthorise";
import { discharge, signOffBill } from "@/money/discharge";
import { authoriseHold, orderHold, sendEstimate } from "@/money/holds";
import { caseMoney } from "@/money/view";
import { paypalRequestId } from "@/paypal/request-id";

import { connectTestDatabase } from "../support/database";
import { DENTAL_LINES, makeDentalCase, type MoneyFixture } from "../support/money";
import { startPayPalDouble } from "../support/paypal-double";
import { recordedAnswer } from "../support/recorded";

const { db } = connectTestDatabase();
const paypal = startPayPalDouble();

const AUTHORISED_AT = new Date("2026-10-13T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const day = (n: number) => new Date(AUTHORISED_AT.getTime() + (n - 1) * DAY + 60 * 60 * 1000);

let fixture: MoneyFixture;
let holdId: string;

/**
 * Makes the case's hold, authorised on 13 October by the given means.
 *
 * @param kind - How the owner paid.
 * @returns The hold's id.
 */
async function heldBy(kind: "paypal" | "card"): Promise<string> {
  const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });
  await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
  const deps = { db, paypal: paypal.client() };
  const { hold: ordered } = await orderHold(deps, { ...fixture, versionId: draft.id });
  paypal.approve(ordered.paypalOrderId, kind);
  paypal.clock.now = AUTHORISED_AT;
  await authoriseHold(deps, { ...fixture, holdId: ordered.id });
  return ordered.id;
}

/**
 * Runs the job with PayPal's clock and the job's own both at a moment.
 *
 * @param at - The moment.
 * @returns The job's report.
 */
async function runAt(at: Date) {
  paypal.clock.now = at;
  return reauthoriseHolds({ db, paypal: paypal.client(), now: at, practiceId: fixture.practiceId });
}

/**
 * The hold's row.
 *
 * @returns The row.
 */
async function stored() {
  const [row] = await db.select().from(hold).where(eq(hold.id, holdId));
  return row!;
}

/**
 * The case's audit actions.
 *
 * @returns The actions, in order.
 */
async function actions(): Promise<string[]> {
  const events = await db
    .select({ action: auditEvent.action })
    .from(auditEvent)
    .where(eq(auditEvent.caseId, fixture.caseId))
    .orderBy(asc(auditEvent.id));
  return events.map((event) => event.action);
}

beforeEach(async () => {
  fixture = await makeDentalCase(db);
});

describe("the reauthorisation job (plan 3.2, U0's P5 (a): once per wallet hold, day 4 to 29)", () => {
  it("reauthorises a day-4 wallet hold once: a new authorisation, which captures go against", async () => {
    holdId = await heldBy("paypal");
    const first = (await stored()).authorizationId!;

    const report = await runAt(day(4));

    expect(report.reauthorised).toEqual([holdId]);
    const row = await stored();
    expect(row.authorizationId).not.toBe(first);
    expect(row.originalAuthorizationId).toBe(first);
    expect(row.reauthorisedAt).not.toBeNull();
    const [asked] = paypal.posts(/\/reauthorize$/);
    expect(asked!.path).toBe(`/v2/payments/authorizations/${first}/reauthorize`);
    expect(asked!.headers["paypal-request-id"]).toBe(
      paypalRequestId({ caseId: fixture.caseId, holdId, step: "reauthorize" }),
    );
    expect(asked!.body).toEqual({ amount: { currency_code: "GBP", value: "773.00" } });
    const [event] = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "hold.reauthorised"))
      .orderBy(asc(auditEvent.id));
    expect(event).toMatchObject({
      caseId: fixture.caseId,
      actor: "system",
      paypalAuthorizationId: row.authorizationId,
      moneyStateBefore: null,
    });

    const version = (await loadEstimateVersion(db, fixture.practiceId, holdId))!;
    await discharge(
      { db, paypal: paypal.client() },
      {
        ...fixture,
        actor: "vet",
        lines: [{ estimateLineId: version.lines[0]!.id, quantity: 1 }],
      },
    );
    expect(paypal.posts(/\/capture$/)[0]!.path).toBe(
      `/v2/payments/authorizations/${row.authorizationId}/capture`,
    );
  });

  it("flags a day-4 card hold, never reauthorising it", async () => {
    holdId = await heldBy("card");

    const report = await runAt(day(4));

    expect(report.flagged).toEqual([holdId]);
    expect(paypal.posts(/\/reauthorize$/)).toHaveLength(0);
    expect((await stored()).honourPeriodFlaggedAt).not.toBeNull();
    expect((await actions()).at(-1)).toBe("hold.honour_period_over");
    expect((await caseMoney(db, fixture.practiceId, fixture.caseId)).state).toBe("held");
  });

  it("does not reauthorise a reauthorised hold again, and flags it once its new honour period is over", async () => {
    holdId = await heldBy("paypal");

    await runAt(day(4));
    const fifth = await runAt(day(5));
    const eighth = await runAt(day(8));
    const ninth = await runAt(day(9));

    expect(paypal.posts(/\/reauthorize$/)).toHaveLength(1);
    expect(fifth).toMatchObject({ reauthorised: [], flagged: [] });
    expect(eighth.flagged).toEqual([holdId]);
    expect(ninth).toMatchObject({ reauthorised: [], flagged: [] });
    expect(
      (await actions()).filter((action) => action.startsWith("hold.reauthorised")),
    ).toHaveLength(1);
    expect((await actions()).filter((action) => action === "hold.honour_period_over")).toHaveLength(
      1,
    );
  });

  it("leaves a hold inside its honour period alone", async () => {
    holdId = await heldBy("paypal");

    const report = await runAt(day(3));

    expect(report).toMatchObject({ reauthorised: [], flagged: [], tooSoon: [] });
    expect(paypal.posts(/\/reauthorize$/)).toHaveLength(0);
  });

  it("never reauthorises a hold whose bill is signed off, and flags it once past its honour period", async () => {
    holdId = await heldBy("paypal");
    const version = (await loadEstimateVersion(db, fixture.practiceId, holdId))!;
    await signOffBill(db, {
      ...fixture,
      actor: "vet",
      lines: [{ estimateLineId: version.lines[0]!.id, quantity: 1 }],
    });

    const report = await runAt(day(4));

    expect(report.reauthorised).toEqual([]);
    expect(report.flagged).toEqual([holdId]);
    expect(paypal.posts(/\/reauthorize$/)).toHaveLength(0);
  });

  it("excludes a sign-off and its discharge while it reauthorises: captures go against the hold's live authorisation", async () => {
    holdId = await heldBy("paypal");
    const version = (await loadEstimateVersion(db, fixture.practiceId, holdId))!;
    paypal.clock.now = day(4);

    await Promise.all([
      reauthoriseHolds({
        db,
        paypal: paypal.client(),
        now: day(4),
        practiceId: fixture.practiceId,
      }),
      discharge(
        { db, paypal: paypal.client() },
        {
          ...fixture,
          actor: "vet",
          lines: [{ estimateLineId: version.lines[0]!.id, quantity: 1 }],
        },
      ),
    ]);

    const row = await stored();
    expect(row.status).toBe("captured");
    const [captured] = paypal.posts(/\/capture$/);
    expect(captured!.path).toBe(`/v2/payments/authorizations/${row.authorizationId}/capture`);
    const live = [...paypal.authorizations.values()].filter(
      (one) => one.status === "CREATED" && one.reauthorisedAs === null,
    );
    expect(live).toEqual([]);
  });

  it("flags a wallet hold past its 29 days that was never reauthorised", async () => {
    holdId = await heldBy("paypal");

    const report = await runAt(day(30));

    expect(report.reauthorised).toEqual([]);
    expect(report.flagged).toEqual([holdId]);
  });

  it("keeps the hold's authorisation when PayPal answers a reauthorisation not CREATED", async () => {
    holdId = await heldBy("paypal");
    const first = (await stored()).authorizationId;
    paypal.inject({
      method: "POST",
      path: /\/reauthorize$/,
      status: 201,
      body: { id: "DENIEDREAUTH00001", status: "DENIED", links: [] },
    });

    const report = await runAt(day(4));

    expect(report.failed).toEqual([holdId]);
    expect((await stored()).authorizationId).toBe(first);
  });

  it("goes on to the next hold when one fails", async () => {
    holdId = await heldBy("paypal");
    // A second case in the same practice, so the run stays inside it.
    const firstFixture = fixture;
    const [other] = await db
      .insert(patientCase)
      .values({
        practiceId: fixture.practiceId,
        patientName: "Pepper",
        ownerName: "B. Owner",
        procedure: "Dental",
      })
      .returning();
    fixture = { practiceId: firstFixture.practiceId, caseId: other!.id };
    const secondHold = await heldBy("paypal");
    fixture = firstFixture;
    paypal.inject({
      method: "POST",
      path: /\/reauthorize$/,
      status: 201,
      body: { id: "BADTIME000000001", status: "CREATED", create_time: "not a time", links: [] },
    });
    paypal.clock.now = day(4);

    const report = await reauthoriseHolds({
      db,
      paypal: paypal.client(),
      now: day(4),
      practiceId: fixture.practiceId,
    });

    // Both holds are as old: whichever goes first meets the bad answer.
    expect(report.failed).toHaveLength(1);
    expect(report.reauthorised).toHaveLength(1);
    expect([...report.failed, ...report.reauthorised].sort()).toEqual([holdId, secondHold].sort());
  });

  it("leaves a hold PayPal says is too soon for the next run, writing nothing", async () => {
    holdId = await heldBy("paypal");
    paypal.inject({
      method: "POST",
      path: /\/reauthorize$/,
      status: 422,
      body: recordedAnswer("P5A", "POST", /\/reauthorize$/).responseBody,
    });
    const before = await actions();

    const refused = await runAt(day(4));
    const next = await reauthoriseHolds({
      db,
      paypal: paypal.client(),
      now: new Date(day(4).getTime() + 60 * 60 * 1000),
      practiceId: fixture.practiceId,
    });

    expect(refused.tooSoon).toEqual([holdId]);
    expect(next.reauthorised).toEqual([holdId]);
    expect((await actions()).slice(before.length)).toEqual(["hold.reauthorised"]);
  });

  it("records a reauthorisation PayPal refuses for good, and flags the hold", async () => {
    holdId = await heldBy("paypal");
    paypal.inject({
      method: "POST",
      path: /\/reauthorize$/,
      status: 422,
      body: {
        name: "UNPROCESSABLE_ENTITY",
        debug_id: "double422",
        details: [{ issue: "REAUTHORIZE_NOT_ALLOWED", description: "not allowed" }],
      },
    });

    const report = await runAt(day(4));
    const again = await runAt(day(5));

    expect(report).toMatchObject({ refused: [holdId], flagged: [holdId] });
    expect(again).toMatchObject({ reauthorised: [], refused: [], flagged: [] });
    expect((await stored()).reauthoriseRefusedAt).not.toBeNull();
    expect((await actions()).slice(-2)).toEqual([
      "hold.reauthorise_refused",
      "hold.honour_period_over",
    ]);
  });
});
