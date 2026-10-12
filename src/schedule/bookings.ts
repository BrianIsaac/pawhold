import { and, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";

import type { Executor } from "@/db/client";
import { booking, bookingKind, patientCase, room, vet } from "@/db/schema";

import { brokenScheduleConstraint, ScheduleError } from "./errors";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const SHORTEST_MS = 15 * 60 * 1000;
const LONGEST_MS = 12 * 60 * 60 * 1000;

/**
 * Whether an instant sits on a five-minute mark (the day's grid, U8a).
 *
 * @param at - The instant.
 * @returns Whether it does.
 */
export function onFiveMinuteMark(at: Date): boolean {
  return at.getTime() % FIVE_MINUTES_MS === 0;
}

/** A booking as a caller asks for it: times in UTC, on the five-minute marks. */
export const bookingInput = z
  .strictObject({
    practiceId: z.uuid(),
    caseId: z.uuid(),
    roomId: z.uuid(),
    vetId: z.uuid(),
    kind: z.enum(bookingKind.enumValues),
    startsAt: z.date().refine(onFiveMinuteMark, "on a five-minute mark"),
    endsAt: z.date().refine(onFiveMinuteMark, "on a five-minute mark"),
  })
  .refine(
    (asked) => {
      const length = asked.endsAt.getTime() - asked.startsAt.getTime();
      return length >= SHORTEST_MS && length <= LONGEST_MS;
    },
    { message: "a booking lasts 15 minutes to 12 hours", path: ["endsAt"] },
  );

export type BookingInput = z.input<typeof bookingInput>;

export type BookingRecord = typeof booking.$inferSelect;

/**
 * Books a case into one of its practice's rooms with one of its vets. The
 * room and the vet must be free then; the database refuses a double booking
 * too (migration 0012), so two callers at once cannot both have it.
 *
 * @param executor - The pool or an open transaction.
 * @param input - The booking.
 * @returns The booking kept.
 * @throws ScheduleError `request_invalid`, `not_found` (the case, room or vet is not the practice's), `room_taken` or `vet_taken`.
 */
export async function bookSlot(executor: Executor, input: BookingInput): Promise<BookingRecord> {
  const parsed = bookingInput.safeParse(input);
  if (!parsed.success) {
    throw new ScheduleError("request_invalid", z.prettifyError(parsed.error));
  }
  const asked = parsed.data;
  const [place] = await executor
    .select({ roomName: room.name, vetName: vet.name, caseId: patientCase.id })
    .from(room)
    .innerJoin(vet, and(eq(vet.id, asked.vetId), eq(vet.practiceId, asked.practiceId)))
    .innerJoin(
      patientCase,
      and(eq(patientCase.id, asked.caseId), eq(patientCase.practiceId, asked.practiceId)),
    )
    .where(and(eq(room.id, asked.roomId), eq(room.practiceId, asked.practiceId)));
  if (!place) {
    throw new ScheduleError("not_found", "That case, room or vet is not this practice's.");
  }
  const overlapping = and(lt(booking.startsAt, asked.endsAt), gt(booking.endsAt, asked.startsAt));
  const [clash] = await executor
    .select({
      roomTaken: sql<boolean>`bool_or(${booking.roomId} = ${asked.roomId})`,
      vetTaken: sql<boolean>`bool_or(${booking.vetId} = ${asked.vetId})`,
    })
    .from(booking)
    .where(
      and(
        overlapping,
        sql`(${booking.roomId} = ${asked.roomId} or ${booking.vetId} = ${asked.vetId})`,
      ),
    );
  if (clash?.roomTaken) {
    throw new ScheduleError("room_taken", `${place.roomName} is already booked then.`);
  }
  if (clash?.vetTaken) {
    throw new ScheduleError("vet_taken", `${place.vetName} is already booked then.`);
  }
  try {
    const [made] = await executor.insert(booking).values(asked).returning();
    if (!made) {
      throw new Error("the booking insert returned no row");
    }
    return made;
  } catch (error) {
    const broken = brokenScheduleConstraint(error);
    if (broken === "booking_room_free") {
      throw new ScheduleError("room_taken", `${place.roomName} is already booked then.`);
    }
    if (broken === "booking_vet_free") {
      throw new ScheduleError("vet_taken", `${place.vetName} is already booked then.`);
    }
    throw error;
  }
}
