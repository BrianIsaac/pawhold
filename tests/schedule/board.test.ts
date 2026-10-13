import { describe, expect, it } from "vitest";

import { axisDate, boardOf, faceOf, hourLabelAt } from "@/schedule/board";
import type { DayBooking, DayView } from "@/schedule/day";

/*
 * The board's mapping (U8b): the day U8a loads, as the Scheduler's resources
 * and events. The board's axis is elapsed time from the day's first hour, on
 * a fixed date of the browser's own clock, so a booking sits where the plain
 * timeline puts it in every time zone; the hour labels are the practice's.
 */

/**
 * A booking of the hand-made day.
 *
 * @param over - What differs from Juno's procedure.
 * @returns The booking.
 */
function bookingOf(over: Partial<DayBooking>): DayBooking {
  return {
    id: "booking-juno",
    caseId: "case-juno",
    patientName: "Juno",
    ownerName: "Ellis Ward",
    procedure: "Lump removal",
    vetName: "Rowan Hale",
    kind: "procedure",
    time: "09:00 to 10:00",
    start: "09:00",
    column: { start: 13, end: 25 },
    chip: { tone: "update_awaiting_owner", label: "Update waiting" },
    held: null,
    moveProposed: null,
    ...over,
  };
}

/** A day from 08:00 to 11:00 with three rooms, one of them empty. */
const VIEW: DayView = {
  day: "2026-10-13",
  label: "Tuesday 13 October",
  isToday: true,
  previousDay: "2026-10-12",
  nextDay: "2026-10-14",
  timeZone: "Europe/London",
  range: {
    from: "2026-10-13T07:00:00.000Z",
    to: "2026-10-13T10:00:00.000Z",
    slots: 36,
    hours: [
      { label: "08:00", line: 1 },
      { label: "09:00", line: 13 },
      { label: "10:00", line: 25 },
      { label: "11:00", line: 37 },
    ],
  },
  now: { line: 16 },
  rooms: [
    {
      id: "room-theatre-1",
      name: "Theatre 1",
      kind: "theatre",
      bookings: [
        bookingOf({ held: { proposalId: "proposal-1", note: "Held by pawhold at 08:35." } }),
        bookingOf({
          id: "booking-biscuit",
          caseId: "case-biscuit",
          patientName: "Biscuit",
          time: "10:00 to 10:45",
          start: "10:00",
          column: { start: 25, end: 34 },
          chip: { tone: "held", label: "Held £412.00" },
          moveProposed: { to: "09:00" },
        }),
      ],
    },
    { id: "room-theatre-2", name: "Theatre 2", kind: "theatre", bookings: [] },
    {
      id: "room-consult",
      name: "Consult room",
      kind: "consult",
      bookings: [
        bookingOf({
          id: "booking-pip",
          caseId: "case-pip",
          patientName: "Pip",
          kind: "consult",
          procedure: "Vaccination",
          vetName: "Imogen Shaw",
          time: "08:15 to 08:30",
          start: "08:15",
          column: { start: 4, end: 7 },
          chip: { tone: "estimate_draft", label: "Estimate draft" },
        }),
      ],
    },
  ],
  proposals: [],
  bookingCount: 3,
};

/**
 * Minutes between the axis' start and a date on it.
 *
 * @param date - The date.
 * @returns The minutes.
 */
function minutesIn(date: Date): number {
  return (date.getTime() - axisDate(1).getTime()) / 60_000;
}

describe("the board's mapping of the day", () => {
  it("makes the rooms the board's resources, in the day's order", () => {
    expect(boardOf(VIEW, 1).resources).toEqual([
      { id: "room-theatre-1", name: "Theatre 1", kind: "theatre" },
      { id: "room-theatre-2", name: "Theatre 2", kind: "theatre" },
      { id: "room-consult", name: "Consult room", kind: "consult" },
    ]);
  });

  it("makes each booking an event in its room, placed by the time elapsed since the day's first hour", () => {
    const board = boardOf(VIEW, 1);

    expect(
      board.events.map((one) => [
        one.id,
        one.resourceId,
        minutesIn(one.startDate),
        minutesIn(one.endDate),
      ]),
    ).toEqual([
      ["booking-juno", "room-theatre-1", 60, 120],
      ["booking-biscuit", "room-theatre-1", 120, 165],
      ["booking-pip", "room-consult", 15, 30],
    ]);
    expect(minutesIn(board.startDate)).toBe(0);
    expect(minutesIn(board.endDate)).toBe(180);
  });

  it("gives an event its case's money tone and words, the agent's hold and the move it proposes", () => {
    const [juno, biscuit, pip] = boardOf(VIEW, 1).events;

    expect(juno).toMatchObject({
      name: "Juno",
      caseId: "case-juno",
      patientName: "Juno",
      detail: "Lump removal",
      vetName: "Rowan Hale",
      time: "09:00 to 10:00",
      start: "09:00",
      tone: "update_awaiting_owner",
      money: "Update waiting",
      held: true,
      moveTo: null,
      room: "Theatre 1",
    });
    expect(biscuit).toMatchObject({ tone: "held", money: "Held £412.00", held: false });
    expect(biscuit!.moveTo).toBe("09:00");
    expect(pip).toMatchObject({
      detail: "Consult",
      tone: "estimate_draft",
      held: false,
      room: "Consult room",
    });
  });

  it("names a booking in full for its tooltip, as the plain timeline does", () => {
    expect(faceOf(VIEW.rooms[0]!.bookings[0]!).title).toBe(
      "09:00 to 10:00: Juno, Lump removal, Rowan Hale. Update waiting.",
    );
    expect(faceOf(VIEW.rooms[2]!.bookings[0]!).title).toBe(
      "08:15 to 08:30: Pip, consult, Imogen Shaw. Estimate draft.",
    );
  });

  it("labels each hour of the axis in the practice's clock", () => {
    const board = boardOf(VIEW, 1);

    expect(board.hours).toEqual(["08:00", "09:00", "10:00"]);
    expect(hourLabelAt(board, axisDate(1))).toBe("08:00");
    expect(hourLabelAt(board, axisDate(25))).toBe("10:00");
    expect(hourLabelAt(board, axisDate(37))).toBe("");
  });

  it("keeps both of the repeated hours on the day the clocks go back", () => {
    const hours = ["00:00", "01:00", "01:00", "02:00", "03:00"].map((label, index) => ({
      label,
      line: index * 12 + 1,
    }));
    const board = boardOf({ ...VIEW, range: { ...VIEW.range, slots: 48, hours }, rooms: [] }, 1);

    expect(board.hours).toEqual(["00:00", "01:00", "01:00", "02:00"]);
    expect(hourLabelAt(board, axisDate(13))).toBe("01:00");
    expect(hourLabelAt(board, axisDate(25))).toBe("01:00");
    expect(hourLabelAt(board, axisDate(37))).toBe("02:00");
  });

  it("draws now only on a day that has it, and opens where the page opens", () => {
    const today = boardOf(VIEW, 11);

    expect(minutesIn(today.now!)).toBe(75);
    expect(minutesIn(today.opensAt)).toBe(50);
    expect(boardOf({ ...VIEW, now: null }, 1).now).toBeNull();
  });

  it("puts the axis on one fixed day of the browser's clock, clear of any change of its clocks", () => {
    const start = axisDate(1);
    const longest = axisDate(25 * 12 + 1);

    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([
      2000, 0, 15, 0,
    ]);
    expect(longest.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
    expect([longest.getDate(), longest.getHours()]).toEqual([16, 1]);
  });
});
