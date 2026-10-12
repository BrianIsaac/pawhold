import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { booking } from "@/db/schema";
import { releaseHold, sweepSchedule } from "@/schedule/agent";
import { bookSlot } from "@/schedule/bookings";
import { loadDay } from "@/schedule/day";
import { ScheduleError } from "@/schedule/errors";
import { dayKeyIn, wallClockIn } from "@/schedule/time";

import { connectTestDatabase } from "../support/database";
import { makeSchedulePractice, openScheduleCase, startSeededDay } from "../support/schedule";

const { db } = connectTestDatabase();
const LONDON = "Europe/London";
const MINUTE_MS = 60 * 1000;

describe("the practice's clock", () => {
  it("finds a London wall-clock time in summer time, in winter time and on the day the clocks go back", () => {
    expect(wallClockIn(LONDON, "2026-10-12", 9 * 60)).toEqual(new Date("2026-10-12T08:00:00Z"));
    expect(wallClockIn(LONDON, "2026-10-26", 9 * 60)).toEqual(new Date("2026-10-26T09:00:00Z"));
    expect(wallClockIn(LONDON, "2026-10-25", 0)).toEqual(new Date("2026-10-24T23:00:00Z"));
    expect(wallClockIn(LONDON, "2026-10-25", 24 * 60)).toEqual(new Date("2026-10-26T00:00:00Z"));
    expect(wallClockIn(LONDON, "2026-10-25", 8 * 60)).toEqual(new Date("2026-10-25T08:00:00Z"));
  });

  it("reads the calendar day of an instant in the practice's zone", () => {
    expect(dayKeyIn(LONDON, new Date("2026-10-12T23:30:00Z"))).toBe("2026-10-13");
    expect(dayKeyIn("UTC", new Date("2026-10-12T23:30:00Z"))).toBe("2026-10-12");
  });
});

describe("the plain day view's data (U8a)", () => {
  it("the plain view shows every booking", async () => {
    const day = await startSeededDay(db);
    const all = await db.select().from(booking).where(eq(booking.practiceId, day.practiceId));
    const days = new Set(
      all.flatMap((one) => [
        dayKeyIn(LONDON, one.startsAt),
        dayKeyIn(LONDON, new Date(one.endsAt.getTime() - 1)),
      ]),
    );

    const shown = new Set<string>();
    for (const key of days) {
      const view = await loadDay(db, day.practiceId, { day: key });
      for (const lane of view.rooms) {
        for (const one of lane.bookings) {
          shown.add(one.id);
          expect(one.column.start).toBeGreaterThanOrEqual(1);
          expect(one.column.end).toBeLessThanOrEqual(view.range.slots + 1);
          expect(one.column.end).toBeGreaterThan(one.column.start);
        }
      }
      expect(view.bookingCount).toBe(
        view.rooms.reduce((sum, lane) => sum + lane.bookings.length, 0),
      );
    }

    expect([...shown].sort()).toEqual(all.map((one) => one.id).sort());
  });

  it("lists the rooms in order, each booking on its five-minute grid with its case and its money chip", async () => {
    const place = await makeSchedulePractice(db);
    const caseId = await openScheduleCase(db, place.practiceId, {
      patientName: "Juno",
      ownerName: "Ellis Moran",
    });
    await bookSlot(db, {
      practiceId: place.practiceId,
      caseId,
      roomId: place.rooms.theatre1,
      vetId: place.vets.first,
      kind: "procedure",
      startsAt: new Date("2026-10-12T08:00:00Z"),
      endsAt: new Date("2026-10-12T09:00:00Z"),
    });

    const view = await loadDay(db, place.practiceId, {
      day: "2026-10-12",
      now: new Date("2026-10-12T12:00:00Z"),
    });

    expect(view).toMatchObject({
      day: "2026-10-12",
      label: "Monday 12 October",
      isToday: true,
      previousDay: "2026-10-11",
      nextDay: "2026-10-13",
      bookingCount: 1,
      range: { from: "2026-10-12T07:00:00.000Z", to: "2026-10-12T17:00:00.000Z", slots: 120 },
      now: { line: 61 },
    });
    expect(view.range.hours[0]).toEqual({ label: "08:00", line: 1 });
    expect(view.range.hours.at(-1)).toEqual({ label: "18:00", line: 121 });
    expect(view.rooms.map((lane) => lane.name)).toEqual(["Theatre 1", "Theatre 2", "Consult room"]);
    expect(view.rooms[0]?.bookings).toEqual([
      {
        id: expect.any(String),
        caseId,
        patientName: "Juno",
        ownerName: "Ellis Moran",
        procedure: "Lump removal",
        vetName: "Rowan Hale",
        kind: "procedure",
        time: "09:00 to 10:00",
        start: "09:00",
        column: { start: 13, end: 25 },
        chip: { tone: "estimate_draft", label: "Estimate draft" },
        held: null,
        moveProposed: null,
      },
    ]);
  });

  it("widens the day past its working hours to the bookings outside them", async () => {
    const place = await makeSchedulePractice(db);
    const caseId = await openScheduleCase(db, place.practiceId, { patientName: "Moss" });
    await bookSlot(db, {
      practiceId: place.practiceId,
      caseId,
      roomId: place.rooms.consult,
      vetId: place.vets.second,
      kind: "consult",
      startsAt: new Date("2026-10-12T05:30:00Z"),
      endsAt: new Date("2026-10-12T05:45:00Z"),
    });

    const view = await loadDay(db, place.practiceId, { day: "2026-10-12" });

    expect(view.range.from).toBe("2026-10-12T05:00:00.000Z");
    expect(view.range.hours[0]).toEqual({ label: "06:00", line: 1 });
    expect(view.rooms[2]?.bookings[0]?.column).toEqual({ start: 7, end: 10 });
  });

  it("reads the day the clocks go back in winter time from 02:00", async () => {
    const place = await makeSchedulePractice(db);
    const caseId = await openScheduleCase(db, place.practiceId, { patientName: "Pip" });
    await bookSlot(db, {
      practiceId: place.practiceId,
      caseId,
      roomId: place.rooms.consult,
      vetId: place.vets.second,
      kind: "consult",
      startsAt: new Date("2026-10-25T09:00:00Z"),
      endsAt: new Date("2026-10-25T09:15:00Z"),
    });

    const view = await loadDay(db, place.practiceId, { day: "2026-10-25" });

    expect(view.range.from).toBe("2026-10-25T08:00:00.000Z");
    expect(view.rooms[2]?.bookings[0]?.time).toBe("09:00 to 09:15");
  });

  it("marks the slot the agent held, the booking it proposes to move, and the proposal with its words", async () => {
    const day = await startSeededDay(db);
    const now = new Date(day.due.startsAt.getTime() - 30 * MINUTE_MS);
    const report = await sweepSchedule(db, { practiceId: day.practiceId, now });
    const key = dayKeyIn(LONDON, day.due.startsAt);

    const view = await loadDay(db, day.practiceId, { day: key, now });

    const theatre = view.rooms.find((lane) => lane.name === "Theatre 1")!;
    const due = theatre.bookings.find((one) => one.id === day.due.id)!;
    const next = theatre.bookings.find((one) => one.id === day.next.id);
    const slot = new Intl.DateTimeFormat("en-GB", {
      timeZone: LONDON,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    expect(due.chip).toEqual({ tone: "update_awaiting_owner", label: "Update waiting" });
    expect(due.held).toEqual({
      proposalId: report.held[0],
      note: `Held by pawhold at ${slot.format(now)}: waiting for approval.`,
    });
    if (next) {
      expect(next.moveProposed).toEqual({ to: slot.format(day.due.startsAt) });
    }
    expect(view.proposals).toEqual([
      {
        id: report.held[0],
        bookingId: day.due.id,
        caseId: day.dueCaseId,
        roomName: "Theatre 1",
        patientName: "Juno",
        slot: slot.format(day.due.startsAt),
        heldNote: `Held by pawhold at ${slot.format(now)}: waiting for approval.`,
        reason: "Ellis hasn't approved the update for Juno.",
        move: {
          bookingId: day.next.id,
          patientName: "Biscuit",
          question: `Move Biscuit's procedure to ${slot.format(day.due.startsAt)}, after Juno's update is answered?`,
        },
      },
    ]);
  });

  it("offers no move once the held slot has started, before the sweep withdraws it", async () => {
    const day = await startSeededDay(db);
    const held = new Date(day.due.startsAt.getTime() - 30 * MINUTE_MS);
    await sweepSchedule(db, { practiceId: day.practiceId, now: held });

    const view = await loadDay(db, day.practiceId, {
      day: dayKeyIn(LONDON, day.due.startsAt),
      now: day.due.startsAt,
    });

    expect(view.proposals[0]?.move).toBeNull();
    for (const lane of view.rooms) {
      for (const one of lane.bookings) {
        expect(one.moveProposed).toBeNull();
      }
    }
  });

  it("labels each hour of the day the clocks go back, the repeated hour twice", async () => {
    const place = await makeSchedulePractice(db);
    const caseId = await openScheduleCase(db, place.practiceId, { patientName: "Moss" });
    await bookSlot(db, {
      practiceId: place.practiceId,
      caseId,
      roomId: place.rooms.consult,
      vetId: place.vets.second,
      kind: "consult",
      startsAt: new Date("2026-10-25T00:30:00Z"),
      endsAt: new Date("2026-10-25T00:45:00Z"),
    });

    const view = await loadDay(db, place.practiceId, { day: "2026-10-25" });

    expect(view.range.from).toBe("2026-10-25T00:00:00.000Z");
    expect(view.range.hours.slice(0, 3)).toEqual([
      { label: "01:00", line: 1 },
      { label: "01:00", line: 13 },
      { label: "02:00", line: 25 },
    ]);
    expect(view.rooms[2]?.bookings[0]).toMatchObject({
      time: "01:30 to 01:45",
      column: { start: 7, end: 10 },
    });
  });

  it("marks nothing once the hold is undone", async () => {
    const day = await startSeededDay(db);
    const now = new Date(day.due.startsAt.getTime() - 30 * MINUTE_MS);
    const [proposalId] = (await sweepSchedule(db, { practiceId: day.practiceId, now })).held;
    await releaseHold(db, { practiceId: day.practiceId, proposalId: proposalId!, now });

    const view = await loadDay(db, day.practiceId, {
      day: dayKeyIn(LONDON, day.due.startsAt),
      now,
    });

    expect(view.proposals).toEqual([]);
    for (const lane of view.rooms) {
      for (const one of lane.bookings) {
        expect(one.held).toBeNull();
        expect(one.moveProposed).toBeNull();
      }
    }
  });

  it("refuses a day that is not a calendar date", async () => {
    const place = await makeSchedulePractice(db);

    for (const day of ["2026-13-01", "2026-02-30", "yesterday", "2026-1-1"]) {
      const error = await loadDay(db, place.practiceId, { day }).then(
        () => null,
        (raised: unknown) => raised,
      );
      expect(error, day).toBeInstanceOf(ScheduleError);
      expect((error as ScheduleError).reason).toBe("request_invalid");
    }
  });
});
