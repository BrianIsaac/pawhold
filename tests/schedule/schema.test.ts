import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { booking, practice, room } from "@/db/schema";

import { connectTestDatabase } from "../support/database";
import { refusalOf } from "../support/postgres-error";
import { makeSchedulePractice, openScheduleCase, type SchedulePractice } from "../support/schedule";

const { db } = connectTestDatabase();

let place: SchedulePractice;
let caseId: string;
let otherCaseId: string;

beforeEach(async () => {
  place = await makeSchedulePractice(db);
  caseId = await openScheduleCase(db, place.practiceId, { patientName: "Juno" });
  otherCaseId = await openScheduleCase(db, place.practiceId, { patientName: "Biscuit" });
});

/**
 * A booking's row in the test practice.
 *
 * @param overrides - Columns to change.
 * @returns The row.
 */
function slot(overrides: Partial<typeof booking.$inferInsert> = {}): typeof booking.$inferInsert {
  return {
    practiceId: place.practiceId,
    caseId,
    roomId: place.rooms.theatre1,
    vetId: place.vets.first,
    kind: "procedure",
    startsAt: new Date("2026-10-12T13:00:00Z"),
    endsAt: new Date("2026-10-12T14:00:00Z"),
    ...overrides,
  };
}

describe("the schedule's tables (U8a)", () => {
  it("keep a booking: a case, a room, a vet, a start and an end, a kind", async () => {
    const [made] = await db.insert(booking).values(slot()).returning();

    expect(made).toMatchObject({
      practiceId: place.practiceId,
      caseId,
      roomId: place.rooms.theatre1,
      vetId: place.vets.first,
      kind: "procedure",
      startsAt: new Date("2026-10-12T13:00:00Z"),
      endsAt: new Date("2026-10-12T14:00:00Z"),
    });
  });

  it("refuse a room booked twice at once", async () => {
    await db.insert(booking).values(slot());

    const refused = await refusalOf(
      db.insert(booking).values(
        slot({
          caseId: otherCaseId,
          vetId: place.vets.second,
          startsAt: new Date("2026-10-12T13:30:00Z"),
          endsAt: new Date("2026-10-12T14:30:00Z"),
        }),
      ),
    );

    expect(refused.code).toBe("23P01");
    expect(refused.message).toContain("booking_room_free");
  });

  it("refuse a vet in two rooms at once", async () => {
    await db.insert(booking).values(slot());

    const refused = await refusalOf(
      db.insert(booking).values(
        slot({
          caseId: otherCaseId,
          roomId: place.rooms.consult,
          kind: "consult",
          startsAt: new Date("2026-10-12T13:45:00Z"),
          endsAt: new Date("2026-10-12T14:00:00Z"),
        }),
      ),
    );

    expect(refused.code).toBe("23P01");
    expect(refused.message).toContain("booking_vet_free");
  });

  it("let one booking start as the one before it ends", async () => {
    await db.insert(booking).values(slot());

    await db.insert(booking).values(
      slot({
        caseId: otherCaseId,
        startsAt: new Date("2026-10-12T14:00:00Z"),
        endsAt: new Date("2026-10-12T15:00:00Z"),
      }),
    );

    const booked = await db.select().from(booking).where(eq(booking.roomId, place.rooms.theatre1));
    expect(booked).toHaveLength(2);
  });

  it("let two bookings change places inside one transaction (the move's swap)", async () => {
    const [first] = await db.insert(booking).values(slot()).returning();
    const [second] = await db
      .insert(booking)
      .values(
        slot({
          caseId: otherCaseId,
          startsAt: new Date("2026-10-12T14:15:00Z"),
          endsAt: new Date("2026-10-12T15:15:00Z"),
        }),
      )
      .returning();

    await db.transaction(async (tx) => {
      await tx
        .update(booking)
        .set({
          startsAt: new Date("2026-10-12T13:00:00Z"),
          endsAt: new Date("2026-10-12T14:00:00Z"),
        })
        .where(eq(booking.id, second!.id));
      await tx
        .update(booking)
        .set({
          startsAt: new Date("2026-10-12T14:00:00Z"),
          endsAt: new Date("2026-10-12T15:00:00Z"),
        })
        .where(eq(booking.id, first!.id));
    });

    const [moved] = await db.select().from(booking).where(eq(booking.id, second!.id));
    expect(moved?.startsAt).toEqual(new Date("2026-10-12T13:00:00Z"));
  });

  it("refuse a booking that ends before it starts, is shorter than 15 minutes or longer than 12 hours", async () => {
    for (const [startsAt, endsAt, name] of [
      ["2026-10-12T14:00:00Z", "2026-10-12T13:00:00Z", "booking_length"],
      ["2026-10-12T13:00:00Z", "2026-10-12T13:10:00Z", "booking_length"],
      ["2026-10-12T06:00:00Z", "2026-10-12T18:05:00Z", "booking_length"],
    ] as const) {
      const refused = await refusalOf(
        db.insert(booking).values(slot({ startsAt: new Date(startsAt), endsAt: new Date(endsAt) })),
      );
      expect(refused.code, `${startsAt} to ${endsAt}`).toBe("23514");
      expect(refused.message).toContain(name);
    }
  });

  it("refuse a booking off the five-minute marks", async () => {
    const refused = await refusalOf(
      db.insert(booking).values(slot({ startsAt: new Date("2026-10-12T13:02:00Z") })),
    );

    expect(refused.code).toBe("23514");
    expect(refused.message).toContain("booking_on_five_minute_marks");
  });

  it("refuse a booking whose case, room or vet is another practice's", async () => {
    const other = await makeSchedulePractice(db, "Another practice");
    const othersCase = await openScheduleCase(db, other.practiceId, { patientName: "Otto" });

    for (const [overrides, key] of [
      [{ caseId: othersCase }, "booking_case_in_practice_fk"],
      [{ roomId: other.rooms.theatre1 }, "booking_room_in_practice_fk"],
      [{ vetId: other.vets.first }, "booking_vet_in_practice_fk"],
    ] as const) {
      const refused = await refusalOf(db.insert(booking).values(slot(overrides)));
      expect(refused.code, key).toBe("23503");
      expect(refused.message).toContain(key);
    }
  });

  it("name each room and vet once per practice", async () => {
    const refused = await refusalOf(
      db
        .insert(room)
        .values({ practiceId: place.practiceId, name: "Theatre 1", kind: "theatre", position: 9 }),
    );

    expect(refused.code).toBe("23505");
  });

  it("give a practice a lead time of 30 minutes and London's clock unless it sets others", async () => {
    const [made] = await db
      .select({ lead: practice.scheduleLeadMinutes, zone: practice.timeZone })
      .from(practice)
      .where(eq(practice.id, place.practiceId));

    expect(made).toEqual({ lead: 30, zone: "Europe/London" });
    const refused = await refusalOf(
      db.execute(sql`update practice set schedule_lead_minutes = 0 where id = ${place.practiceId}`),
    );
    expect(refused.code).toBe("23514");
  });
});
