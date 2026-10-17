import { and, asc, eq, inArray, max } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { checkExplanation, checkOwnerWording, findSpan } from "@/agent/guardrails";
import { auditEvent, booking, patientCase, room, vet } from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { createJudgeSessionHandlers } from "@/judge/session";
import { HONOUR_PERIOD_OVER_REASON, reauthoriseHolds } from "@/jobs/reauthorise";
import { caseMoney } from "@/money/view";
import type { PayPalClient } from "@/paypal/client";
import { todaysCases } from "@/practice/cases";

import { seedFictionalPractice } from "../../seed/practice";
import { DAY_CASES, DAY_ROOMS, DAY_VETS } from "../../seed/practice/day";
import { SHOWCASE_CASE } from "../../seed/practice/showcase";
import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();
const ORIGIN = "https://pawhold.test";
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let practiceId: string;
let startedAt: Date;
let caseIds: Map<string, string>;

beforeAll(async () => {
  const handlers = createJudgeSessionHandlers({
    db,
    secret: "test-session-secret-0123456789abcdef-not-real",
    seed: seedFictionalPractice,
  });
  startedAt = new Date();
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
 * The seeded practice's bookings, with their case's patient, room and vet, in time order.
 *
 * @returns The bookings.
 */
async function seededBookings() {
  return db
    .select({
      patientName: patientCase.patientName,
      roomName: room.name,
      vetName: vet.name,
      kind: booking.kind,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      moneyState: patientCase.moneyState,
      caseVet: patientCase.vetName,
    })
    .from(booking)
    .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
    .innerJoin(room, eq(room.id, booking.roomId))
    .innerJoin(vet, eq(vet.id, booking.vetId))
    .where(eq(booking.practiceId, practiceId))
    .orderBy(asc(booking.startsAt));
}

describe("the seeded day (U8a)", () => {
  it("gives the practice two theatres, one consult room and two vets", async () => {
    const rooms = await db
      .select({ name: room.name, kind: room.kind, position: room.position })
      .from(room)
      .where(eq(room.practiceId, practiceId))
      .orderBy(asc(room.position));
    const vets = await db
      .select({ name: vet.name })
      .from(vet)
      .where(eq(vet.practiceId, practiceId))
      .orderBy(asc(vet.name));

    expect(rooms).toEqual([
      { name: "Theatre 1", kind: "theatre", position: 1 },
      { name: "Theatre 2", kind: "theatre", position: 2 },
      { name: "Consult room", kind: "consult", position: 3 },
    ]);
    expect(rooms.map((one) => one.name)).toEqual(DAY_ROOMS.map((one) => one.name));
    expect(vets.map((one) => one.name)).toEqual([...DAY_VETS].sort());
  });

  it("books every case of the practice, the showcase case's procedure among them", async () => {
    const booked = await seededBookings();

    expect(new Set(booked.map((one) => one.patientName))).toEqual(
      new Set([SHOWCASE_CASE.patientName, ...DAY_CASES.map((kase) => kase.patientName)]),
    );
    const bramble = booked.filter((one) => one.patientName === SHOWCASE_CASE.patientName);
    expect(bramble.map((one) => [one.roomName, one.kind])).toEqual([
      ["Theatre 1", "procedure"],
      ["Consult room", "consult"],
    ]);
    const versions = await caseEstimateVersions(
      db,
      practiceId,
      caseIds.get(SHOWCASE_CASE.patientName)!,
    );
    const updateSentAt = versions[1]!.sentAt!;
    expect(bramble[0]!.startsAt.getTime()).toBeLessThan(updateSentAt.getTime());
    expect(bramble[0]!.endsAt.getTime()).toBeGreaterThan(updateSentAt.getTime());
    for (const one of booked) {
      expect(one.vetName, one.patientName).toBe(one.caseVet);
    }
  });

  it("has the day's case waiting on its update, its procedure due within the lead time", async () => {
    const booked = await seededBookings();
    const theatre = booked.filter(
      (one) => one.roomName === "Theatre 1" && one.startsAt > startedAt,
    );
    const [due, next] = theatre;

    expect(due).toMatchObject({ patientName: "Juno", kind: "procedure" });
    expect(due!.moneyState).toBe("update_awaiting_owner");
    const leadMs = due!.startsAt.getTime() - startedAt.getTime();
    expect(leadMs).toBeGreaterThan(20 * MINUTE_MS);
    expect(leadMs).toBeLessThanOrEqual(30 * MINUTE_MS);
    expect(next).toMatchObject({ patientName: "Biscuit", kind: "procedure", moneyState: "held" });
  });

  it("keeps each case's money as its stage has it, every hold a card's with seeded ids", async () => {
    for (const kase of DAY_CASES) {
      const money = await caseMoney(db, practiceId, caseIds.get(kase.patientName)!);
      expect(money.state, kase.patientName).toBe(kase.moneyState);
      for (const held of money.holds) {
        expect(held, kase.patientName).toMatchObject({ status: "authorised", paymentKind: "card" });
        expect(held.paypalOrderId).toMatch(/^SEEDED[0-9A-F]{10}$/);
        expect(held.authorizationId).toMatch(/^SEEDED[0-9A-F]{10}$/);
      }
      const holds = kase.moneyState === "estimate_draft" || kase.moneyState === "awaiting_owner";
      expect(money.holds.length, kase.patientName).toBe(holds ? 0 : 1);
    }
  });

  it("is what the agent's guardrails would let through: every span in its words, every wording clean", async () => {
    for (const kase of DAY_CASES) {
      const versions = await caseEstimateVersions(db, practiceId, caseIds.get(kase.patientName)!);
      const [estimate, update] = versions;
      for (const line of estimate?.lines ?? []) {
        expect(findSpan(kase.notes!, line.notesSpan!), line.code).not.toBeNull();
        expect(checkOwnerWording(line.ownerWording!), line.code).toBeNull();
      }
      for (const line of update?.lines.slice(estimate!.lines.length) ?? []) {
        expect(findSpan(kase.finding!, line.notesSpan!), line.code).not.toBeNull();
        expect(checkOwnerWording(line.ownerWording!), line.code).toBeNull();
      }
      if (kase.explanation) {
        expect(checkExplanation(kase.explanation, kase.finding!)).toBeNull();
      }
    }
  });

  it("tells each case's story as seeded events, all before the showcase case's last, so it stays first", async () => {
    const ids = DAY_CASES.map((kase) => caseIds.get(kase.patientName)!);
    const events = await db
      .select()
      .from(auditEvent)
      .where(inArray(auditEvent.caseId, ids))
      .orderBy(asc(auditEvent.id));
    const [showcaseLast] = await db
      .select({ at: max(auditEvent.occurredAt) })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.practiceId, practiceId),
          eq(auditEvent.caseId, caseIds.get(SHOWCASE_CASE.patientName)!),
        ),
      );

    expect(events.length).toBeGreaterThan(DAY_CASES.length);
    for (const event of events) {
      expect(event.detail, event.action).toMatchObject({ seeded: true });
      expect(event.occurredAt.getTime()).toBeLessThan(showcaseLast!.at!.getTime());
    }
    const juno = events
      .filter((event) => event.caseId === caseIds.get("Juno"))
      .map((event) => `${event.actor} ${event.action}`);
    expect(juno).toEqual([
      "vet case.opened",
      "vet estimate.version_made",
      "vet estimate.approved",
      "vet estimate.sent",
      "owner hold.ordered",
      "owner hold.authorised",
      "vet estimate.version_made",
      "vet estimate.approved",
      "vet estimate.sent",
    ]);
    const [first] = await todaysCases(db, practiceId);
    expect(first?.patientName).toBe(SHOWCASE_CASE.patientName);
  });

  it("never sends a seeded hold to PayPal: the hourly rule flags the day's holds instead, as seeded", async () => {
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

    await reauthoriseHolds({
      db,
      paypal: refusing,
      practiceId,
      now: new Date(Date.now() + 5 * DAY_MS),
    });

    expect(asked).toEqual([]);
    const dayCaseIds = (await todaysCases(db, practiceId))
      .filter((listed) => DAY_CASES.some((kase) => kase.patientName === listed.patientName))
      .map((listed) => listed.id);
    const flagged = await db
      .select({ detail: auditEvent.detail })
      .from(auditEvent)
      .where(
        and(
          inArray(auditEvent.caseId, dayCaseIds),
          eq(auditEvent.action, "hold.honour_period_over"),
        ),
      );
    expect(flagged.length).toBeGreaterThan(0);
    for (const { detail } of flagged) {
      expect(detail).toMatchObject({ reason: HONOUR_PERIOD_OVER_REASON.seeded });
    }
  });
});
