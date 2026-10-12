import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";

import type { Executor } from "@/db/client";
import { booking, patientCase, room, scheduleProposal, vet } from "@/db/schema";
import { caseMoney } from "@/money/view";
import { type MoneyChip, moneyChips } from "@/practice/chips";

import { ScheduleError } from "./errors";
import { scheduleSettings } from "./settings";
import { dayIn, dayKeyIn, minuteIn, wallClockIn } from "./time";
import { heldNote, moveQuestion } from "./wording";

const SLOT_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The working day the view shows at least, on the practice's wall clock, in minutes after midnight. */
export const WORKING_DAY = { from: 8 * 60, to: 18 * 60 } as const;

/** One booking on the day's grid. */
export interface DayBooking {
  readonly id: string;
  readonly caseId: string;
  readonly patientName: string;
  readonly ownerName: string;
  readonly procedure: string;
  readonly vetName: string;
  readonly kind: "procedure" | "consult";
  /** "09:00 to 10:00", in the practice's clock. */
  readonly time: string;
  /** "09:00": the start alone, for a booking too short to show its whole time. */
  readonly start: string;
  /** The grid lines it spans, one line per five minutes from the range's start (the first is 1). */
  readonly column: { readonly start: number; readonly end: number };
  /** Its case's money chip, in the board's colours (U5's chips). */
  readonly chip: MoneyChip;
  /** The agent's hold on it (section 6's words), or null. */
  readonly held: { readonly proposalId: string; readonly note: string } | null;
  /** Where the agent proposes to move it, or null. */
  readonly moveProposed: { readonly to: string } | null;
}

/** One room's lane. */
export interface DayRoom {
  readonly id: string;
  readonly name: string;
  readonly kind: "theatre" | "consult";
  readonly bookings: readonly DayBooking[];
}

/** One open act of the agent on the day: the hold, and the move it proposes if still proposed. */
export interface DayProposal {
  readonly id: string;
  readonly bookingId: string;
  readonly caseId: string;
  readonly roomName: string;
  readonly patientName: string;
  /** The held slot's start ("14:05"). */
  readonly slot: string;
  /** "Held by pawhold at {time}: waiting for approval." */
  readonly heldNote: string;
  /** Why it was held, as the agent wrote it. */
  readonly reason: string;
  readonly move: {
    readonly bookingId: string;
    readonly patientName: string;
    readonly question: string;
  } | null;
}

/** The practice's day as the plain view draws it (and U8b's board binds to). */
export interface DayView {
  /** The calendar day shown, "2026-10-12". */
  readonly day: string;
  /** "Monday 12 October". */
  readonly label: string;
  readonly isToday: boolean;
  readonly previousDay: string;
  readonly nextDay: string;
  readonly timeZone: string;
  readonly range: {
    readonly from: string;
    readonly to: string;
    /** Five-minute columns. */
    readonly slots: number;
    /** Each hour's label and the grid line it starts on. */
    readonly hours: readonly { readonly label: string; readonly line: number }[];
  };
  /** The grid line now falls on, when today is shown and now is inside the range. */
  readonly now: { readonly line: number } | null;
  readonly rooms: readonly DayRoom[];
  readonly proposals: readonly DayProposal[];
  readonly bookingCount: number;
}

/**
 * Whether a day key names a real calendar date.
 *
 * @param key - "2026-10-12".
 * @returns Whether it does.
 */
function calendarDate(key: string): boolean {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const dayKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a day as YYYY-MM-DD")
  .refine(calendarDate, "a calendar date");

/**
 * The calendar day before or after another.
 *
 * @param key - The day.
 * @param by - Days to move.
 * @returns The day moved to.
 */
function shiftDay(key: string, by: number): string {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + by)).toISOString().slice(0, 10);
}

/**
 * The practice's day (U8a): its rooms in order, every booking that falls on
 * the day placed on a five-minute grid, each coloured by its case's money
 * chip, the agent's holds and proposed moves marked, and the open proposals
 * with section 6's words. The grid runs from 08:00 to 18:00 on the practice's
 * clock, widened to the hour around any booking outside it.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param options - The day ("2026-10-12"; today by default) and the clock.
 * @param options.day - The day.
 * @param options.now - The clock.
 * @returns The day.
 * @throws ScheduleError `request_invalid` for a day that is not a calendar date; `not_found` for no such practice.
 */
export async function loadDay(
  executor: Executor,
  practiceId: string,
  options: { day?: string | undefined; now?: Date | undefined } = {},
): Promise<DayView> {
  const now = options.now ?? new Date();
  const { timeZone } = await scheduleSettings(executor, practiceId);
  const today = dayKeyIn(timeZone, now);
  const parsed = dayKey.safeParse(options.day ?? today);
  if (!parsed.success) {
    throw new ScheduleError("request_invalid", "That is not a day of the calendar.");
  }
  const day = parsed.data;
  const dayStart = wallClockIn(timeZone, day, 0);
  const dayEnd = wallClockIn(timeZone, day, 24 * 60);

  const rooms = await executor
    .select({ id: room.id, name: room.name, kind: room.kind })
    .from(room)
    .where(eq(room.practiceId, practiceId))
    .orderBy(asc(room.position));
  const rows = await executor
    .select({
      id: booking.id,
      caseId: booking.caseId,
      roomId: booking.roomId,
      kind: booking.kind,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      vetName: vet.name,
      patientName: patientCase.patientName,
      ownerName: patientCase.ownerName,
      procedure: patientCase.procedure,
    })
    .from(booking)
    .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
    .innerJoin(vet, eq(vet.id, booking.vetId))
    .where(
      and(
        eq(booking.practiceId, practiceId),
        lt(booking.startsAt, dayEnd),
        gt(booking.endsAt, dayStart),
      ),
    )
    .orderBy(asc(booking.startsAt));

  const workFrom = wallClockIn(timeZone, day, WORKING_DAY.from);
  const workTo = wallClockIn(timeZone, day, WORKING_DAY.to);
  const earliest = Math.min(workFrom.getTime(), ...rows.map((row) => row.startsAt.getTime()));
  const latest = Math.max(workTo.getTime(), ...rows.map((row) => row.endsAt.getTime()));
  const from = new Date(Math.max(dayStart.getTime(), floorToHour(earliest, workFrom)));
  const to = new Date(Math.min(dayEnd.getTime(), ceilToHour(latest, workFrom)));
  const slots = Math.round((to.getTime() - from.getTime()) / SLOT_MS);
  const line = (at: Date): number =>
    Math.round(
      (Math.min(Math.max(at.getTime(), from.getTime()), to.getTime()) - from.getTime()) / SLOT_MS,
    ) + 1;

  const hours: { label: string; line: number }[] = [];
  for (let at = from.getTime(); at <= to.getTime(); at += HOUR_MS) {
    hours.push({ label: minuteIn(timeZone, new Date(at)), line: line(new Date(at)) });
  }

  const open = await openProposals(
    executor,
    practiceId,
    rows.map((row) => row.id),
  );
  const heldBy = new Map(open.map((proposal) => [proposal.bookingId, proposal]));
  const movedBy = new Map(
    open
      .filter((proposal) => moveOpen(proposal, now))
      .map((proposal) => [proposal.moveBookingId!, proposal]),
  );
  const chips = new Map<string, MoneyChip>();
  for (const caseId of new Set(rows.map((row) => row.caseId))) {
    const [chip] = moneyChips(await caseMoney(executor, practiceId, caseId));
    chips.set(caseId, chip!);
  }

  const byRoom = new Map<string, DayBooking[]>();
  for (const row of rows) {
    const held = heldBy.get(row.id);
    const moved = movedBy.get(row.id);
    const lane = byRoom.get(row.roomId) ?? [];
    byRoom.set(row.roomId, lane);
    lane.push({
      id: row.id,
      caseId: row.caseId,
      patientName: row.patientName,
      ownerName: row.ownerName,
      procedure: row.procedure,
      vetName: row.vetName,
      kind: row.kind,
      time: `${minuteIn(timeZone, row.startsAt)} to ${minuteIn(timeZone, row.endsAt)}`,
      start: minuteIn(timeZone, row.startsAt),
      column: { start: line(row.startsAt), end: line(row.endsAt) },
      chip: chips.get(row.caseId)!,
      held: held ? { proposalId: held.id, note: heldNote(minuteIn(timeZone, held.heldAt)) } : null,
      moveProposed: moved ? { to: minuteIn(timeZone, moved.moveTo!) } : null,
    });
  }

  const nowInside = day === today && now >= from && now <= to;
  return {
    day,
    label: dayIn(timeZone, wallClockIn(timeZone, day, 12 * 60)),
    isToday: day === today,
    previousDay: shiftDay(day, -1),
    nextDay: shiftDay(day, 1),
    timeZone,
    range: { from: from.toISOString(), to: to.toISOString(), slots, hours },
    now: nowInside ? { line: line(now) } : null,
    rooms: rooms.map((lane) => ({ ...lane, bookings: byRoom.get(lane.id) ?? [] })),
    proposals: open.map((proposal) => ({
      id: proposal.id,
      bookingId: proposal.bookingId,
      caseId: proposal.caseId,
      roomName: proposal.roomName,
      patientName: proposal.patientName,
      slot: minuteIn(timeZone, proposal.startsAt),
      heldNote: heldNote(minuteIn(timeZone, proposal.heldAt)),
      reason: proposal.reason,
      move:
        moveOpen(proposal, now) && proposal.moveBookingId && proposal.movePatientName
          ? {
              bookingId: proposal.moveBookingId,
              patientName: proposal.movePatientName,
              question: moveQuestion(
                proposal.movePatientName,
                minuteIn(timeZone, proposal.moveTo!),
                proposal.patientName,
              ),
            }
          : null,
    })),
    bookingCount: rows.length,
  };
}

/**
 * The open proposals holding any of the day's bookings, with what their words need.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param bookingIds - The day's bookings.
 * @returns The proposals, earliest held slot first.
 */
async function openProposals(executor: Executor, practiceId: string, bookingIds: string[]) {
  if (bookingIds.length === 0) {
    return [];
  }
  const proposals = await executor
    .select({
      id: scheduleProposal.id,
      bookingId: scheduleProposal.bookingId,
      caseId: scheduleProposal.caseId,
      reason: scheduleProposal.reason,
      heldAt: scheduleProposal.heldAt,
      moveBookingId: scheduleProposal.moveBookingId,
      moveTo: scheduleProposal.moveTo,
      moveStatus: scheduleProposal.moveStatus,
      roomName: room.name,
      patientName: patientCase.patientName,
      startsAt: booking.startsAt,
    })
    .from(scheduleProposal)
    .innerJoin(booking, eq(booking.id, scheduleProposal.bookingId))
    .innerJoin(room, eq(room.id, booking.roomId))
    .innerJoin(patientCase, eq(patientCase.id, scheduleProposal.caseId))
    .where(
      and(
        eq(scheduleProposal.practiceId, practiceId),
        isNull(scheduleProposal.releasedAt),
        inArray(scheduleProposal.bookingId, bookingIds),
      ),
    )
    .orderBy(asc(booking.startsAt));
  const moving = proposals.flatMap((proposal) =>
    proposal.moveBookingId ? [proposal.moveBookingId] : [],
  );
  const names =
    moving.length === 0
      ? []
      : await executor
          .select({ id: booking.id, patientName: patientCase.patientName })
          .from(booking)
          .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
          .where(inArray(booking.id, moving));
  const nameOf = new Map(names.map((one) => [one.id, one.patientName]));
  return proposals.map((proposal) => ({
    ...proposal,
    movePatientName: proposal.moveBookingId ? (nameOf.get(proposal.moveBookingId) ?? null) : null,
  }));
}

/**
 * An instant moved back to the hour on the practice's clock, counted from a
 * known hour mark of the same day (zones whose offset is not whole hours keep
 * their own marks).
 *
 * @param at - The instant, in milliseconds.
 * @param mark - An hour mark of the day.
 * @returns The hour at or before it.
 */
function floorToHour(at: number, mark: Date): number {
  return mark.getTime() + Math.floor((at - mark.getTime()) / HOUR_MS) * HOUR_MS;
}

/**
 * An instant moved on to the hour on the practice's clock.
 *
 * @param at - The instant, in milliseconds.
 * @param mark - An hour mark of the day.
 * @returns The hour at or after it.
 */
function ceilToHour(at: number, mark: Date): number {
  return mark.getTime() + Math.ceil((at - mark.getTime()) / HOUR_MS) * HOUR_MS;
}

/**
 * Whether a proposal's move can still be made: proposed, and its held slot not
 * yet started (the next sweep withdraws one that has).
 *
 * @param proposal - The proposal.
 * @param proposal.moveStatus - Where its move stands.
 * @param proposal.moveBookingId - The booking it would move.
 * @param proposal.moveTo - Where it would move it to.
 * @param now - The clock.
 * @returns Whether the move is offered.
 */
function moveOpen(
  proposal: { moveStatus: string | null; moveBookingId: string | null; moveTo: Date | null },
  now: Date,
): boolean {
  return (
    proposal.moveStatus === "proposed" &&
    proposal.moveBookingId !== null &&
    proposal.moveTo !== null &&
    proposal.moveTo.getTime() > now.getTime()
  );
}
