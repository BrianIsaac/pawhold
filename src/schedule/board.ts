import type { MoneyChipTone } from "@/practice/chips";

import type { DayBooking, DayView } from "./day";

/** The minutes one grid line of the day's view stands for. */
const LINE_MINUTES = 5;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** What a booking's block shows, on the plain timeline and on the board alike. */
export interface BookingFace {
  readonly caseId: string;
  readonly patientName: string;
  /** The procedure, or "Consult". */
  readonly detail: string;
  readonly vetName: string;
  /** "09:00 to 10:00", in the practice's clock. */
  readonly time: string;
  /** "09:00": the start alone, for a block too short to show its whole time. */
  readonly start: string;
  /** Its case's money state: the block's colour (U11's tones). */
  readonly tone: MoneyChipTone;
  /** Its case's money in words ("Held £412.00"). */
  readonly money: string;
  /** Whether the agent holds its slot. */
  readonly held: boolean;
  /** Where the agent proposes to move it ("09:00"), or null. */
  readonly moveTo: string | null;
  /** The booking in full, for its tooltip. */
  readonly title: string;
}

/** One room, as the board's resource. */
export interface BoardResource {
  readonly id: string;
  readonly name: string;
  readonly kind: "theatre" | "consult";
}

/** One booking, as the board's event: where it sits, and its face laid flat so a change of any part is seen. */
export interface BoardEvent extends BookingFace {
  readonly id: string;
  readonly resourceId: string;
  /** The patient: the event's name. */
  readonly name: string;
  readonly startDate: Date;
  readonly endDate: Date;
  /** Its room's name, which the block says to a reader who cannot see the row it sits in. */
  readonly room: string;
}

/** The practice's day as the Scheduler binds it. */
export interface DayBoardData {
  /** The calendar day shown, "2026-10-12". */
  readonly day: string;
  readonly startDate: Date;
  readonly endDate: Date;
  /** Each hour's label along the axis, in the practice's clock. */
  readonly hours: readonly string[];
  readonly resources: readonly BoardResource[];
  readonly events: readonly BoardEvent[];
  /** Where now falls on the axis, when the day shown has it. */
  readonly now: Date | null;
  /** Where the board opens scrolled to. */
  readonly opensAt: Date;
}

/**
 * The date on the board's axis of one of the day's grid lines. The axis is
 * elapsed time from the day's first hour, laid on 15 January 2000 of the
 * browser's own clock: a date on which no zone changes its clocks, so five
 * minutes of the practice's day are five minutes of the axis whatever zone
 * the browser is in and whatever the practice's clock does that day. The
 * hours are labelled from the practice's clock ({@link hourLabelAt}), never
 * from these dates.
 *
 * @param line - The grid line (the first is 1), five minutes each.
 * @returns The date.
 */
export function axisDate(line: number): Date {
  return new Date(2000, 0, 15, 0, (line - 1) * LINE_MINUTES);
}

/**
 * A booking's face: what its block shows.
 *
 * @param booking - The booking, from the day's view.
 * @returns Its face.
 */
export function faceOf(booking: DayBooking): BookingFace {
  const consult = booking.kind === "consult";
  return {
    caseId: booking.caseId,
    patientName: booking.patientName,
    detail: consult ? "Consult" : booking.procedure,
    vetName: booking.vetName,
    time: booking.time,
    start: booking.start,
    tone: booking.chip.tone,
    money: booking.chip.label,
    held: booking.held !== null,
    moveTo: booking.moveProposed?.to ?? null,
    title: `${booking.time}: ${booking.patientName}, ${consult ? "consult" : booking.procedure}, ${booking.vetName}. ${booking.chip.label}.`,
  };
}

/**
 * The practice's day as the board binds it (U8b): the rooms as resources in
 * the day's order, each booking an event in its room coloured by its case's
 * money, the agent's hold and proposed move on it, placed by the time elapsed
 * since the day's first hour.
 *
 * @param view - The day, from `loadDay`.
 * @param openingLine - The grid line the day opens at (the page's `openingLine`).
 * @returns The board's data.
 */
export function boardOf(view: DayView, openingLine: number): DayBoardData {
  return {
    day: view.day,
    startDate: axisDate(1),
    endDate: axisDate(view.range.slots + 1),
    hours: view.range.hours.slice(0, -1).map((hour) => hour.label),
    resources: view.rooms.map((lane) => ({ id: lane.id, name: lane.name, kind: lane.kind })),
    events: view.rooms.flatMap((lane) =>
      lane.bookings.map((one) => ({
        id: one.id,
        resourceId: lane.id,
        name: one.patientName,
        startDate: axisDate(one.column.start),
        endDate: axisDate(one.column.end),
        room: lane.name,
        ...faceOf(one),
      })),
    ),
    now: view.now ? axisDate(view.now.line) : null,
    opensAt: axisDate(openingLine),
  };
}

/**
 * The label of the hour that starts at a date on the board's axis.
 *
 * @param board - The board's data.
 * @param at - The hour's start on the axis.
 * @returns The practice's clock at that hour ("09:00"), or "" past the day's end.
 */
export function hourLabelAt(board: Pick<DayBoardData, "startDate" | "hours">, at: Date): string {
  return board.hours[Math.round((at.getTime() - board.startDate.getTime()) / HOUR_MS)] ?? "";
}
