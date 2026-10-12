import type { Executor } from "../../src/db/client";
import { patientCase, practice, room, vet } from "../../src/db/schema";

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
