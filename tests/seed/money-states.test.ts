import { and, asc, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { checkExplanation, checkOwnerWording, findSpan } from "@/agent/guardrails";
import {
  allocation,
  auditEvent,
  bill,
  billLine,
  capture,
  hold,
  patientCase,
  refund,
} from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { createJudgeSessionHandlers } from "@/judge/session";
import { refundableCaptures } from "@/discharge/refund";
import { reauthoriseHolds } from "@/jobs/reauthorise";
import { MoneyError } from "@/money/errors";
import { refundCaptured } from "@/money/refunds";
import { caseMoney } from "@/money/view";
import type { PayPalClient } from "@/paypal/client";
import { todaysCases } from "@/practice/cases";

import { seedFictionalPractice } from "../../seed/practice";
import { MONEY_STATE_CASES, OWNER_DOOR_CASE } from "../../seed/showcase/cases";
import { SHOWCASE_CASES_BY_STATE, SHOWCASE_STATES } from "../../seed/showcase";
import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();
const ORIGIN = "https://pawhold.test";
const DAY_MS = 24 * 60 * 60 * 1000;

let practiceId: string;
let caseIds: Map<string, string>;

beforeAll(async () => {
  const handlers = createJudgeSessionHandlers({
    db,
    secret: "test-session-secret-0123456789abcdef-not-real",
    seed: seedFictionalPractice,
  });
  const started = await handlers.POST(
    new Request(`${ORIGIN}/api/judge/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ door: "practice" }),
    }),
  );
  practiceId = ((await started.json()) as { practiceId: string }).practiceId;
  const cases = await db
    .select({ id: patientCase.id, patientName: patientCase.patientName })
    .from(patientCase)
    .where(eq(patientCase.practiceId, practiceId));
  caseIds = new Map(cases.map((kase) => [kase.patientName, kase.id]));
});

/**
 * A seeded case's id by its patient.
 *
 * @param patientName - The patient.
 * @returns The case's id.
 */
function caseOf(patientName: string): string {
  const id = caseIds.get(patientName);
  if (!id) {
    throw new Error(`the showcase has no case for ${patientName}`);
  }
  return id;
}

/**
 * A case's chips on today's list, in their words.
 *
 * @returns The chips' words by patient.
 */
async function chipsByPatient(): Promise<Map<string, string[]>> {
  const listed = await todaysCases(db, practiceId);
  return new Map(listed.map((kase) => [kase.patientName, kase.chips.map((chip) => chip.label)]));
}

describe("the showcase (plan 3.2: cases at every money state)", () => {
  it("shows every money state on today's list in section 6's chip words, the day and Bramble folded in", async () => {
    const chips = await chipsByPatient();

    expect(Object.fromEntries(chips)).toEqual({
      Pip: ["Estimate draft"],
      Moss: ["Estimate draft"],
      Otis: ["Waiting for owner"],
      Archie: ["Waiting for owner"],
      Hazel: ["Held £586.00"],
      Willow: [expect.stringMatching(/^Held £/)],
      Biscuit: [expect.stringMatching(/^Held £/)],
      Clover: [expect.stringMatching(/^Held £/)],
      Juno: ["Update waiting"],
      Bramble: ["Update declined", "Hold extended"],
      Rufus: ["Held £1,714.00", "Honour period over"],
      Poppy: ["Captured £197.00"],
      Teddy: ["Released £430.00"],
      Luna: ["Refunded £20.00"],
      Milo: ["Withdrawn"],
    });
  });

  it("names a seeded case for each state, and each named case is in it", async () => {
    expect(Object.keys(SHOWCASE_CASES_BY_STATE)).toEqual([...SHOWCASE_STATES]);
    for (const [state, patients] of Object.entries(SHOWCASE_CASES_BY_STATE)) {
      expect(patients.length, state).toBeGreaterThan(0);
      for (const patient of patients) {
        const money = await caseMoney(db, practiceId, caseOf(patient));
        const open = money.holds.filter((one) => one.status === "authorised");
        const shown = {
          estimate_draft: money.state === "estimate_draft",
          awaiting_owner: money.state === "awaiting_owner",
          held_paypal: money.state === "held" && open.every((one) => one.paymentKind === "paypal"),
          held_card: money.state === "held" && open.every((one) => one.paymentKind === "card"),
          update_awaiting_owner: money.state === "update_awaiting_owner",
          update_declined: money.state === "update_declined",
          hold_extended: open.some((one) => one.reauthorisedAt !== null),
          honour_period_over: open.some(
            (one) => one.paymentKind === "card" && one.honourPeriodFlaggedAt !== null,
          ),
          captured: money.state === "captured",
          released: money.state === "released",
          refunded: money.state === "refunded",
          withdrawn: money.state === "withdrawn",
        }[state as (typeof SHOWCASE_STATES)[number]];
        expect(shown, `${patient} shows ${state}`).toBe(true);
      }
    }
  });

  it("opens the owner's door on an estimate waiting for its owner, with a range over the Order's £500", async () => {
    const [estimate] = await caseEstimateVersions(
      db,
      practiceId,
      caseOf(OWNER_DOOR_CASE.patientName),
    );

    expect(estimate?.sentAt).not.toBeNull();
    expect(estimate?.totals).toEqual({ lowPence: 87_600, highPence: 101_000 });
    expect((await caseMoney(db, practiceId, caseOf("Otis"))).holds).toEqual([]);
  });

  it("gives PayPal no id of its own: every seeded hold, capture and refund id begins SEEDED", async () => {
    const holds = await db.select().from(hold).where(eq(hold.practiceId, practiceId));
    const ids = holds.flatMap((one) => [
      one.paypalOrderId,
      one.authorizationId,
      one.originalAuthorizationId,
    ]);
    const captures = await db
      .select()
      .from(capture)
      .where(
        inArray(
          capture.holdId,
          holds.map((one) => one.id),
        ),
      );
    const refunds = await db
      .select()
      .from(refund)
      .where(
        inArray(
          refund.captureId,
          captures.map((one) => one.id),
        ),
      );
    const events = await db.select().from(auditEvent).where(eq(auditEvent.practiceId, practiceId));
    const all = [
      ...ids,
      ...captures.flatMap((one) => [one.paypalCaptureId, one.authorizationId]),
      ...refunds.map((one) => one.paypalRefundId),
      ...events.flatMap((one) => [
        one.paypalOrderId,
        one.paypalAuthorizationId,
        one.paypalCaptureId,
        one.paypalRefundId,
      ]),
    ].filter((id): id is string => id !== null);

    expect(captures.length).toBeGreaterThan(0);
    expect(refunds.length).toBeGreaterThan(0);
    expect(all.filter((id) => !/^SEEDED[0-9A-F]{10}$/.test(id))).toEqual([]);
  });

  it("says every case's event is seeded (D16), in order and in the past", async () => {
    const events = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.practiceId, practiceId)))
      .orderBy(asc(auditEvent.id));
    const onCases = events.filter((event) => event.caseId !== null);

    expect(onCases.length).toBeGreaterThan(100);
    for (const event of onCases) {
      expect(event.detail, event.action).toMatchObject({ seeded: true });
      expect(event.occurredAt.getTime(), event.action).toBeLessThan(Date.now());
    }
    for (const kase of MONEY_STATE_CASES) {
      const times = onCases
        .filter((event) => event.caseId === caseOf(kase.patientName))
        .map((event) => event.occurredAt.getTime());
      expect(times, kase.patientName).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it("writes the discharged case as U7 lists its rows: the bill allocated, one final capture per hold it takes from, the rest voided", async () => {
    const teddy = caseOf("Teddy");
    const [signed] = await db.select().from(bill).where(eq(bill.caseId, teddy));
    const lines = await db.select().from(billLine).where(eq(billLine.billId, signed!.id));
    const parts = await db
      .select()
      .from(allocation)
      .where(
        inArray(
          allocation.billLineId,
          lines.map((line) => line.id),
        ),
      );
    const holds = await db
      .select()
      .from(hold)
      .where(eq(hold.caseId, teddy))
      .orderBy(asc(hold.versionNumber));
    const captures = await db
      .select()
      .from(capture)
      .where(
        inArray(
          capture.holdId,
          holds.map((one) => one.id),
        ),
      );
    const events = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.caseId, teddy))
      .orderBy(asc(auditEvent.id));

    expect(signed).toMatchObject({ totalPence: 48_200, signedOffBy: "vet" });
    expect(lines).toHaveLength(5);
    expect(parts.reduce((sum, part) => sum + part.amountPence, 0)).toBe(48_200);
    expect(holds.map((one) => [one.status, one.closedAt !== null])).toEqual([
      ["captured", true],
      ["voided", true],
    ]);
    expect(captures).toEqual([
      expect.objectContaining({
        holdId: holds[0]!.id,
        amountPence: 48_200,
        finalCapture: true,
        status: "completed",
        confirmedAt: expect.any(Date),
      }),
    ]);
    const signedOff = events.find((event) => event.action === "bill.signed_off");
    expect(signedOff?.detail).toMatchObject({
      billId: signed!.id,
      holds: [
        {
          holdId: holds[0]!.id,
          capturePence: 48_200,
          releasePence: 15_000,
          closeBy: "final_capture",
        },
        { holdId: holds[1]!.id, capturePence: 0, releasePence: 28_000, closeBy: "void" },
      ],
      releasedPence: 43_000,
      seeded: true,
    });
    expect(
      events
        .slice(events.indexOf(signedOff!))
        .map((event) => [event.action, event.moneyStateBefore, event.moneyStateAfter]),
    ).toEqual([
      ["bill.signed_off", "held", "held"],
      ["hold.captured", "held", "captured"],
      ["hold.voided", "captured", "released"],
    ]);
  });

  it("writes the refunded case as U7 lists its rows: two holds captured whole, then a goodwill refund", async () => {
    const luna = caseOf("Luna");
    const holds = await db
      .select()
      .from(hold)
      .where(eq(hold.caseId, luna))
      .orderBy(asc(hold.versionNumber));
    const captures = await db
      .select()
      .from(capture)
      .where(
        inArray(
          capture.holdId,
          holds.map((one) => one.id),
        ),
      );
    const [returned] = await db
      .select()
      .from(refund)
      .where(
        inArray(
          refund.captureId,
          captures.map((one) => one.id),
        ),
      );
    const events = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.caseId, luna))
      .orderBy(asc(auditEvent.id));

    expect(holds.map((one) => [one.status, one.paymentKind, one.amountPence])).toEqual([
      ["captured", "paypal", 54_100],
      ["captured", "card", 34_500],
    ]);
    expect(captures.map((one) => one.amountPence).sort()).toEqual([34_500, 54_100]);
    expect(returned).toMatchObject({
      amountPence: 2_000,
      status: "completed",
      requestedBy: "vet",
      confirmedAt: expect.any(Date),
    });
    expect(captures.find((one) => one.id === returned!.captureId)?.status).toBe(
      "partially_refunded",
    );
    expect(events.slice(-2).map((event) => [event.action, event.moneyStateAfter])).toEqual([
      ["capture.refund_requested", null],
      ["capture.refunded", "refunded"],
    ]);
    expect(events.at(-1)?.detail).toMatchObject({
      refundId: returned!.id,
      reason: returned!.reason,
    });
  });

  it("writes the withdrawn case's order left unapproved, nothing to void", async () => {
    const [only] = await db
      .select()
      .from(hold)
      .where(eq(hold.caseId, caseOf("Milo")));
    const [last] = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.caseId, caseOf("Milo")))
      .orderBy(asc(auditEvent.id))
      .then((events) => events.slice(-1));

    expect(only).toMatchObject({ status: "withdrawn", authorizationId: null });
    expect(last).toMatchObject({
      action: "estimate.withdrawn",
      moneyStateBefore: "awaiting_owner",
      moneyStateAfter: "withdrawn",
    });
  });

  it("is what the agent's guardrails would let through: every span in its words, every wording clean", async () => {
    for (const kase of MONEY_STATE_CASES) {
      for (const line of kase.lines) {
        expect(
          findSpan(kase.notes, line.notesSpan!),
          `${kase.patientName} ${line.code}`,
        ).not.toBeNull();
        expect(
          checkOwnerWording(line.ownerWording!),
          `${kase.patientName} ${line.code}`,
        ).toBeNull();
      }
      for (const line of kase.updateLines ?? []) {
        expect(
          findSpan(kase.finding!, line.notesSpan!),
          `${kase.patientName} ${line.code}`,
        ).not.toBeNull();
        expect(
          checkOwnerWording(line.ownerWording!),
          `${kase.patientName} ${line.code}`,
        ).toBeNull();
      }
      if (kase.explanation) {
        expect(checkExplanation(kase.explanation, kase.finding!), kase.patientName).toBeNull();
      }
    }
  });

  it("never sends a seeded hold to PayPal: the hourly rule over the practice for the session's week asks PayPal nothing", async () => {
    const asked: string[] = [];
    const refusing: PayPalClient = {
      get: async (path) => {
        asked.push(path);
        throw new Error("a seeded hold must never reach PayPal");
      },
      post: async (path) => {
        asked.push(path);
        throw new Error("a seeded hold must never reach PayPal");
      },
    };

    for (let day = 1; day <= 8; day += 1) {
      const report = await reauthoriseHolds({
        db,
        paypal: refusing,
        practiceId,
        now: new Date(Date.now() + day * DAY_MS),
      });
      expect(report.failed, `day ${day}`).toEqual([]);
    }

    expect(asked).toEqual([]);
    const chips = await chipsByPatient();
    expect(chips.get("Hazel")).toEqual(["Held £586.00", "Honour period over"]);
  });

  it("never refunds a seeded capture at PayPal: it is refused, and no refund is offered for it", async () => {
    const asked: string[] = [];
    const refusing: PayPalClient = {
      get: async (path) => {
        asked.push(path);
        throw new Error("a seeded capture must never reach PayPal");
      },
      post: async (path) => {
        asked.push(path);
        throw new Error("a seeded capture must never reach PayPal");
      },
    };
    const poppy = caseOf("Poppy");
    const [taken] = await db
      .select({ id: capture.id })
      .from(capture)
      .innerJoin(hold, eq(hold.id, capture.holdId))
      .where(eq(hold.caseId, poppy));

    const refused = await refundCaptured(
      { db, paypal: refusing },
      {
        practiceId,
        caseId: poppy,
        captureId: taken!.id,
        amountPence: 1_000,
        reason: "Goodwill",
        actor: "vet",
      },
    ).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(MoneyError);
    expect((refused as MoneyError).reason).toBe("refund_refused");
    expect(asked).toEqual([]);
    expect(await db.select().from(refund).where(eq(refund.captureId, taken!.id))).toEqual([]);
    for (const patient of ["Poppy", "Teddy", "Luna"]) {
      expect(await refundableCaptures(db, practiceId, caseOf(patient)), patient).toEqual([]);
    }
  });
});
