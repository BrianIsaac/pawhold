import { and, asc, eq } from "drizzle-orm";

import type { Database, Executor } from "../../src/db/client";
import { booking, patientCase, practice, room, vet } from "../../src/db/schema";
import { createJudgeSessionHandlers } from "../../src/judge/session";
import { seedFictionalPractice } from "../../seed/practice";

/** A practice made for a schedule test: two theatres, a consult room and two vets. */
export interface SchedulePractice {
  readonly practiceId: string;
  readonly rooms: {
    readonly theatre1: string;
    readonly theatre2: string;
    readonly consult: string;
  };
  readonly vets: { readonly first: string; readonly second: string };
}

/**
 * Makes a practice with the rooms and vets the seeded day has, and nothing else.
 *
 * @param db - The test database.
 * @param name - The practice's name.
 * @returns The practice, its rooms and its vets.
 */
export async function makeSchedulePractice(
  db: Executor,
  name = "Schedule test practice",
): Promise<SchedulePractice> {
  const [made] = await db
    .insert(practice)
    .values({ name, kind: "judge" })
    .returning({ id: practice.id });
  const practiceId = made!.id;
  const rooms = await db
    .insert(room)
    .values([
      { practiceId, name: "Theatre 1", kind: "theatre", position: 1 },
      { practiceId, name: "Theatre 2", kind: "theatre", position: 2 },
      { practiceId, name: "Consult room", kind: "consult", position: 3 },
    ])
    .returning({ id: room.id, name: room.name });
  const vets = await db
    .insert(vet)
    .values([
      { practiceId, name: "Rowan Hale" },
      { practiceId, name: "Imogen Shaw" },
    ])
    .returning({ id: vet.id, name: vet.name });
  const roomId = (roomName: string): string => rooms.find((one) => one.name === roomName)!.id;
  const vetId = (vetName: string): string => vets.find((one) => one.name === vetName)!.id;
  return {
    practiceId,
    rooms: {
      theatre1: roomId("Theatre 1"),
      theatre2: roomId("Theatre 2"),
      consult: roomId("Consult room"),
    },
    vets: { first: vetId("Rowan Hale"), second: vetId("Imogen Shaw") },
  };
}

/**
 * Opens a case in a practice, in the money state given.
 *
 * @param db - The test database.
 * @param practiceId - The practice.
 * @param kase - The patient, the owner and the money state.
 * @param kase.patientName - The patient.
 * @param kase.ownerName - The owner.
 * @param kase.moneyState - The case's money state.
 * @returns The case's id.
 */
export async function openScheduleCase(
  db: Executor,
  practiceId: string,
  kase: {
    patientName: string;
    ownerName?: string;
    moneyState?: (typeof patientCase.$inferInsert)["moneyState"];
  },
): Promise<string> {
  const [made] = await db
    .insert(patientCase)
    .values({
      practiceId,
      patientName: kase.patientName,
      ownerName: kase.ownerName ?? "Alex Owner",
      procedure: "Lump removal",
      vetName: "Rowan Hale",
      moneyState: kase.moneyState ?? "estimate_draft",
    })
    .returning({ id: patientCase.id });
  return made!.id;
}

/** A judge's practice as the seed lays it, with the day's bookings the agent's tests act on. */
export interface SeededDayPractice {
  readonly practiceId: string;
  /** The day's case, Juno: its update waits on the owner. */
  readonly dueCaseId: string;
  /** Juno's procedure in theatre 1, due inside the lead time from the seed. */
  readonly due: BookingRow;
  /** Biscuit's procedure, next in theatre 1. */
  readonly next: BookingRow;
  readonly theatre1: string;
  readonly consultRoom: string;
  readonly vets: Readonly<Record<string, string>>;
}

type BookingRow = typeof booking.$inferSelect;

/**
 * Starts a judge's session through U1's handler with the application's seed,
 * and reads back the seeded day's bookings in theatre 1.
 *
 * @param db - The test database.
 * @returns The practice and the day's bookings.
 */
export async function startSeededDay(db: Database["db"]): Promise<SeededDayPractice> {
  const handlers = createJudgeSessionHandlers({
    db,
    secret: "test-session-secret-0123456789abcdef-not-real",
    seed: seedFictionalPractice,
  });
  const started = await handlers.POST(
    new Request("https://pawhold.test/api/judge/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pawhold.test" },
      body: JSON.stringify({ door: "practice" }),
    }),
  );
  const { practiceId } = (await started.json()) as { practiceId: string };
  const rooms = await db
    .select({ id: room.id, name: room.name })
    .from(room)
    .where(eq(room.practiceId, practiceId));
  const vets = await db
    .select({ id: vet.id, name: vet.name })
    .from(vet)
    .where(eq(vet.practiceId, practiceId));
  const theatre1 = rooms.find((one) => one.name === "Theatre 1")!.id;
  const inTheatre = await db
    .select({ booking, patientName: patientCase.patientName })
    .from(booking)
    .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
    .where(and(eq(booking.practiceId, practiceId), eq(booking.roomId, theatre1)))
    .orderBy(asc(booking.startsAt));
  const named = (patientName: string): BookingRow =>
    inTheatre.find((one) => one.patientName === patientName)!.booking;
  const due = named("Juno");
  return {
    practiceId,
    dueCaseId: due.caseId,
    due,
    next: named("Biscuit"),
    theatre1,
    consultRoom: rooms.find((one) => one.name === "Consult room")!.id,
    vets: Object.fromEntries(vets.map((one) => [one.name, one.id])),
  };
}
