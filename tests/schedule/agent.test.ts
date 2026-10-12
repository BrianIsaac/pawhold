import { and, asc, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent, booking, scheduleProposal } from "@/db/schema";
import { declineUpdate } from "@/money/holds";
import { applyMove, dismissMove, releaseHold, sweepSchedule } from "@/schedule/agent";
import { bookSlot } from "@/schedule/bookings";
import { ScheduleError } from "@/schedule/errors";
import { setScheduleSettings } from "@/schedule/settings";

import { connectTestDatabase } from "../support/database";
import { type SeededDayPractice, startSeededDay } from "../support/schedule";

const { db } = connectTestDatabase();
const MINUTE_MS = 60 * 1000;

let day: SeededDayPractice;

beforeEach(async () => {
  day = await startSeededDay(db);
});

/**
 * An instant some minutes before the day's case is due.
 *
 * @param minutes - How many minutes before its start.
 * @returns The instant.
 */
function beforeDue(minutes: number): Date {
  return new Date(day.due.startsAt.getTime() - minutes * MINUTE_MS);
}

/**
 * Sweeps the test's practice only, as the hourly job and the day view do for all.
 *
 * @param now - The clock.
 * @returns What the sweep did.
 */
function sweep(now: Date) {
  return sweepSchedule(db, { practiceId: day.practiceId, now });
}

/**
 * The practice's schedule events, in the order written.
 *
 * @returns The events.
 */
async function scheduleEvents() {
  return db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.practiceId, day.practiceId), like(auditEvent.action, "schedule.%")))
    .orderBy(asc(auditEvent.id));
}

/**
 * A booking's times as kept.
 *
 * @param bookingId - The booking.
 * @returns Its start and end.
 */
async function timesOf(bookingId: string): Promise<{ startsAt: Date; endsAt: Date }> {
  const [found] = await db
    .select({ startsAt: booking.startsAt, endsAt: booking.endsAt })
    .from(booking)
    .where(eq(booking.id, bookingId));
  return found!;
}

/**
 * The refusal a call raised.
 *
 * @param call - The call.
 * @returns The schedule's refusal.
 */
async function refusal(call: Promise<unknown>): Promise<ScheduleError> {
  const error = await call.then(
    () => null,
    (raised: unknown) => raised,
  );
  expect(error).toBeInstanceOf(ScheduleError);
  return error as ScheduleError;
}

/**
 * The one proposal the sweep made, after a sweep at the lead time.
 *
 * @returns Its id.
 */
async function heldAtLead(): Promise<string> {
  const report = await sweep(beforeDue(30));
  expect(report.held).toHaveLength(1);
  return report.held[0]!;
}

describe("the schedule agent (plan 3.4's third job, D9 (a))", () => {
  it("an update unanswered 30 minutes before its slot proposes a hold", async () => {
    const report = await sweep(beforeDue(30));

    expect(report.held).toHaveLength(1);
    const [proposal] = await db
      .select()
      .from(scheduleProposal)
      .where(eq(scheduleProposal.id, report.held[0]!));
    expect(proposal).toMatchObject({
      bookingId: day.due.id,
      caseId: day.dueCaseId,
      reason: "Ellis hasn't approved the update for Juno.",
      heldAt: beforeDue(30),
      releasedAt: null,
      moveBookingId: day.next.id,
      moveTo: day.due.startsAt,
      moveStatus: "proposed",
    });
    const events = await scheduleEvents();
    expect(events.map((event) => `${event.actor} ${event.action}`)).toEqual([
      "schedule_agent schedule.slot_held",
      "schedule_agent schedule.move_proposed",
    ]);
    expect(events[0]).toMatchObject({
      caseId: day.dueCaseId,
      detail: {
        proposalId: proposal!.id,
        bookingId: day.due.id,
        caseId: day.dueCaseId,
        roomId: day.theatre1,
        reason: "Ellis hasn't approved the update for Juno.",
      },
    });
    expect(events[1]?.detail).toMatchObject({
      proposalId: proposal!.id,
      bookingId: day.due.id,
      caseId: day.dueCaseId,
      roomId: day.theatre1,
      moveBookingId: day.next.id,
      moveCaseId: day.next.caseId,
      moveTo: day.due.startsAt.toISOString(),
    });
  });

  it("holds nothing further off than the lead time, nor a slot already started", async () => {
    expect(await sweep(beforeDue(31))).toEqual({
      held: [],
      moveProposed: [],
      released: [],
      withdrawn: [],
    });
    expect((await sweep(beforeDue(0))).held).toEqual([]);
    expect(await scheduleEvents()).toEqual([]);
  });

  it("holds nothing once the update is answered", async () => {
    await declineUpdate(db, { practiceId: day.practiceId, caseId: day.dueCaseId, actor: "owner" });

    expect((await sweep(beforeDue(30))).held).toEqual([]);
  });

  it("reads the lead time from the practice's setting", async () => {
    await setScheduleSettings(db, {
      practiceId: day.practiceId,
      leadMinutes: 45,
      timeZone: "Europe/London",
    });

    expect((await sweep(beforeDue(46))).held).toEqual([]);
    expect((await sweep(beforeDue(45))).held).toHaveLength(1);
  });

  it("a move is never applied without a click", async () => {
    const proposalId = await heldAtLead();
    const before = await timesOf(day.next.id);

    for (const minutes of [20, 10, 1]) {
      await sweep(beforeDue(minutes));
    }

    expect(await timesOf(day.next.id)).toEqual(before);
    const [still] = await db
      .select({ moveStatus: scheduleProposal.moveStatus })
      .from(scheduleProposal)
      .where(eq(scheduleProposal.id, proposalId));
    expect(still?.moveStatus).toBe("proposed");

    await applyMove(db, { practiceId: day.practiceId, proposalId, now: beforeDue(5) });

    const nextLength = day.next.endsAt.getTime() - day.next.startsAt.getTime();
    const dueLength = day.due.endsAt.getTime() - day.due.startsAt.getTime();
    expect(await timesOf(day.next.id)).toEqual({
      startsAt: day.due.startsAt,
      endsAt: new Date(day.due.startsAt.getTime() + nextLength),
    });
    expect(await timesOf(day.due.id)).toEqual({
      startsAt: new Date(day.due.startsAt.getTime() + nextLength),
      endsAt: new Date(day.due.startsAt.getTime() + nextLength + dueLength),
    });
    const applied = (await scheduleEvents()).at(-1);
    expect(applied).toMatchObject({ actor: "vet", action: "schedule.move_applied" });
  });

  it("an answered update releases the hold and withdraws the proposal", async () => {
    const proposalId = await heldAtLead();
    await declineUpdate(db, { practiceId: day.practiceId, caseId: day.dueCaseId, actor: "owner" });

    const report = await sweep(beforeDue(20));

    expect(report).toEqual({
      held: [],
      moveProposed: [],
      released: [proposalId],
      withdrawn: [proposalId],
    });
    const [after] = await db
      .select()
      .from(scheduleProposal)
      .where(eq(scheduleProposal.id, proposalId));
    expect(after).toMatchObject({
      releasedAt: beforeDue(20),
      releasedBy: "agent",
      moveStatus: "withdrawn",
      moveDecidedAt: beforeDue(20),
    });
    const events = (await scheduleEvents()).slice(2);
    expect(events.map((event) => `${event.actor} ${event.action}`)).toEqual([
      "schedule_agent schedule.proposal_withdrawn",
      "schedule_agent schedule.slot_released",
    ]);
    expect(events[0]?.detail).toMatchObject({ why: "update_answered" });
    expect(events[1]?.detail).toMatchObject({
      why: "update_answered",
      moneyState: "update_declined",
    });
  });

  it("a second sweep changes nothing", async () => {
    await sweep(beforeDue(30));
    const written = (await scheduleEvents()).length;

    expect(await sweep(beforeDue(30))).toEqual({
      held: [],
      moveProposed: [],
      released: [],
      withdrawn: [],
    });
    expect(await sweep(beforeDue(29))).toEqual({
      held: [],
      moveProposed: [],
      released: [],
      withdrawn: [],
    });
    expect(await scheduleEvents()).toHaveLength(written);
  });

  it("holds once when two sweeps run at once", async () => {
    const [first, second] = await Promise.all([sweep(beforeDue(30)), sweep(beforeDue(30))]);

    expect([...first.held, ...second.held]).toHaveLength(1);
    expect(await scheduleEvents()).toHaveLength(2);
  });

  it("undoes a hold with one click, withdrawing its move, and never holds it again for the same update", async () => {
    const proposalId = await heldAtLead();

    await releaseHold(db, { practiceId: day.practiceId, proposalId, now: beforeDue(25) });

    const [after] = await db
      .select()
      .from(scheduleProposal)
      .where(eq(scheduleProposal.id, proposalId));
    expect(after).toMatchObject({
      releasedAt: beforeDue(25),
      releasedBy: "practice",
      moveStatus: "withdrawn",
    });
    expect(
      (await scheduleEvents()).slice(2).map((event) => `${event.actor} ${event.action}`),
    ).toEqual(["schedule_agent schedule.proposal_withdrawn", "vet schedule.slot_released"]);
    expect((await sweep(beforeDue(20))).held).toEqual([]);
    const refused = await refusal(
      releaseHold(db, { practiceId: day.practiceId, proposalId, now: beforeDue(19) }),
    );
    expect(refused.reason).toBe("hold_released");
  });

  it("keeps the hold when the move is dismissed, and then refuses to make the move", async () => {
    const proposalId = await heldAtLead();

    await dismissMove(db, { practiceId: day.practiceId, proposalId, now: beforeDue(25) });

    const [after] = await db
      .select()
      .from(scheduleProposal)
      .where(eq(scheduleProposal.id, proposalId));
    expect(after).toMatchObject({ releasedAt: null, moveStatus: "dismissed" });
    expect((await scheduleEvents()).at(-1)).toMatchObject({
      actor: "vet",
      action: "schedule.proposal_dismissed",
    });
    const refused = await refusal(
      applyMove(db, { practiceId: day.practiceId, proposalId, now: beforeDue(24) }),
    );
    expect(refused.reason).toBe("move_not_open");
  });

  it("refuses a move once the held slot has started, and the sweep withdraws it", async () => {
    const proposalId = await heldAtLead();

    const refused = await refusal(
      applyMove(db, { practiceId: day.practiceId, proposalId, now: beforeDue(0) }),
    );
    expect(refused.reason).toBe("move_too_late");

    const report = await sweep(beforeDue(-1));
    expect(report).toEqual({ held: [], moveProposed: [], released: [], withdrawn: [proposalId] });
    expect((await scheduleEvents()).at(-1)?.detail).toMatchObject({ why: "slot_started" });
  });

  it("proposes no move that would put a vet in two places at once", async () => {
    await bookSlot(db, {
      practiceId: day.practiceId,
      caseId: day.next.caseId,
      roomId: day.consultRoom,
      vetId: day.due.vetId,
      kind: "consult",
      startsAt: day.due.endsAt,
      endsAt: new Date(day.due.endsAt.getTime() + 15 * MINUTE_MS),
    });

    const report = await sweep(beforeDue(30));

    expect(report.held).toHaveLength(1);
    expect(report.moveProposed).toEqual([]);
    expect((await scheduleEvents()).map((event) => event.action)).toEqual(["schedule.slot_held"]);
  });

  it("refuses a move that has come to put a vet in two places, naming the vet, and moves nothing", async () => {
    const proposalId = await heldAtLead();
    await bookSlot(db, {
      practiceId: day.practiceId,
      caseId: day.next.caseId,
      roomId: day.consultRoom,
      vetId: day.due.vetId,
      kind: "consult",
      startsAt: day.due.endsAt,
      endsAt: new Date(day.due.endsAt.getTime() + 15 * MINUTE_MS),
    });

    const refused = await refusal(
      applyMove(db, { practiceId: day.practiceId, proposalId, now: beforeDue(20) }),
    );

    expect(refused.reason).toBe("move_clash");
    expect(refused.message).toBe("That move would put Rowan Hale in two places at once.");
    expect(await timesOf(day.next.id)).toEqual({
      startsAt: day.next.startsAt,
      endsAt: day.next.endsAt,
    });
  });

  it("acts only on the practice's own proposals", async () => {
    const proposalId = await heldAtLead();
    const other = await startSeededDay(db);

    for (const act of [applyMove, dismissMove, releaseHold]) {
      const refused = await refusal(act(db, { practiceId: other.practiceId, proposalId }));
      expect(refused.reason).toBe("proposal_not_found");
    }
    const malformed = await refusal(
      applyMove(db, { practiceId: day.practiceId, proposalId: "not-an-id" }),
    );
    expect(malformed.reason).toBe("request_invalid");
  });

  it("writes one audit event per transition, each carrying the booking, the case and the room", async () => {
    const first = await heldAtLead();
    await applyMove(db, { practiceId: day.practiceId, proposalId: first, now: beforeDue(25) });
    await declineUpdate(db, { practiceId: day.practiceId, caseId: day.dueCaseId, actor: "owner" });
    await sweep(beforeDue(20));

    const events = await scheduleEvents();

    expect(events.map((event) => event.action)).toEqual([
      "schedule.slot_held",
      "schedule.move_proposed",
      "schedule.move_applied",
      "schedule.slot_released",
    ]);
    for (const event of events) {
      expect(event.caseId, event.action).toBe(day.dueCaseId);
      expect(event.detail, event.action).toMatchObject({
        proposalId: first,
        bookingId: day.due.id,
        caseId: day.dueCaseId,
        roomId: day.theatre1,
      });
    }
  });
});
