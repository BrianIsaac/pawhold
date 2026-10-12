import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent } from "@/db/schema";
import { bookSlot, type BookingInput } from "@/schedule/bookings";
import { ScheduleError } from "@/schedule/errors";
import { scheduleSettings, setScheduleSettings } from "@/schedule/settings";

import { connectTestDatabase } from "../support/database";
import { makeSchedulePractice, openScheduleCase, type SchedulePractice } from "../support/schedule";

const { db } = connectTestDatabase();

let place: SchedulePractice;
let caseId: string;

beforeEach(async () => {
  place = await makeSchedulePractice(db);
  caseId = await openScheduleCase(db, place.practiceId, { patientName: "Juno" });
});

/**
 * What `bookSlot` is given for a procedure in theatre 1 with the first vet.
 *
 * @param overrides - Fields to change, malformed ones among them.
 * @returns The request, typed as the caller's though it may not be one.
 */
function request(overrides: Record<string, unknown> = {}): BookingInput {
  return {
    practiceId: place.practiceId,
    caseId,
    roomId: place.rooms.theatre1,
    vetId: place.vets.first,
    kind: "procedure",
    startsAt: new Date("2026-10-12T13:00:00Z"),
    endsAt: new Date("2026-10-12T14:00:00Z"),
    ...overrides,
  } as BookingInput;
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

describe("bookSlot", () => {
  it("books a case into a room with a vet", async () => {
    const booked = await bookSlot(db, request());

    expect(booked).toMatchObject({
      caseId,
      roomId: place.rooms.theatre1,
      vetId: place.vets.first,
      kind: "procedure",
      startsAt: new Date("2026-10-12T13:00:00Z"),
      endsAt: new Date("2026-10-12T14:00:00Z"),
    });
  });

  it("refuses a room already booked then, naming it", async () => {
    await bookSlot(db, request());
    const second = await openScheduleCase(db, place.practiceId, { patientName: "Biscuit" });

    const refused = await refusal(
      bookSlot(
        db,
        request({
          caseId: second,
          vetId: place.vets.second,
          startsAt: new Date("2026-10-12T13:30:00Z"),
          endsAt: new Date("2026-10-12T14:30:00Z"),
        }),
      ),
    );

    expect(refused.reason).toBe("room_taken");
    expect(refused.message).toBe("Theatre 1 is already booked then.");
  });

  it("refuses a vet already booked then, naming them", async () => {
    await bookSlot(db, request());
    const second = await openScheduleCase(db, place.practiceId, { patientName: "Biscuit" });

    const refused = await refusal(
      bookSlot(
        db,
        request({
          caseId: second,
          roomId: place.rooms.consult,
          kind: "consult",
          startsAt: new Date("2026-10-12T13:45:00Z"),
          endsAt: new Date("2026-10-12T14:00:00Z"),
        }),
      ),
    );

    expect(refused.reason).toBe("vet_taken");
    expect(refused.message).toBe("Rowan Hale is already booked then.");
  });

  it("refuses a malformed request before the database", async () => {
    for (const overrides of [
      { kind: "surgery" },
      { startsAt: new Date("2026-10-12T13:02:00Z") },
      { endsAt: new Date("2026-10-12T13:10:00Z") },
      { endsAt: new Date("2026-10-12T12:00:00Z") },
      { caseId: "not-an-id" },
      { extra: true },
    ]) {
      const refused = await refusal(bookSlot(db, request(overrides)));
      expect(refused.reason, JSON.stringify(overrides)).toBe("request_invalid");
    }
  });

  it("refuses a case, room or vet that is not the practice's", async () => {
    const other = await makeSchedulePractice(db, "Another practice");

    for (const overrides of [
      { roomId: other.rooms.theatre1 },
      { vetId: other.vets.first },
      { caseId: await openScheduleCase(db, other.practiceId, { patientName: "Otto" }) },
    ]) {
      const refused = await refusal(bookSlot(db, request(overrides)));
      expect(refused.reason, JSON.stringify(overrides)).toBe("not_found");
    }
  });
});

describe("the practice's schedule settings", () => {
  it("are a lead time of 30 minutes and London's clock by default", async () => {
    expect(await scheduleSettings(db, place.practiceId)).toEqual({
      leadMinutes: 30,
      timeZone: "Europe/London",
    });
  });

  it("change by the practice's word, as an audit event", async () => {
    await setScheduleSettings(db, {
      practiceId: place.practiceId,
      leadMinutes: 45,
      timeZone: "Europe/Dublin",
    });

    expect(await scheduleSettings(db, place.practiceId)).toEqual({
      leadMinutes: 45,
      timeZone: "Europe/Dublin",
    });
    const events = await db
      .select({ action: auditEvent.action, actor: auditEvent.actor, detail: auditEvent.detail })
      .from(auditEvent)
      .where(eq(auditEvent.practiceId, place.practiceId));
    expect(events).toEqual([
      {
        action: "practice.schedule_settings_changed",
        actor: "vet",
        detail: {
          leadMinutes: 45,
          timeZone: "Europe/Dublin",
          previous: { leadMinutes: 30, timeZone: "Europe/London" },
        },
      },
    ]);
  });

  it("refuse a lead time outside 5 minutes to 4 hours, or a zone no clock knows", async () => {
    for (const settings of [
      { leadMinutes: 4, timeZone: "Europe/London" },
      { leadMinutes: 241, timeZone: "Europe/London" },
      { leadMinutes: 30.5, timeZone: "Europe/London" },
      { leadMinutes: 30, timeZone: "Middle/Earth" },
    ]) {
      const refused = await refusal(
        setScheduleSettings(db, { practiceId: place.practiceId, ...settings }),
      );
      expect(refused.reason, JSON.stringify(settings)).toBe("request_invalid");
    }
  });
});
