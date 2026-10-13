import { describe, expect, it } from "vitest";

import { practiceClock } from "@/practice/time";
import { setScheduleSettings } from "@/schedule/settings";
import { caseTimeline } from "@/practice/timeline";
import { auditEvent, patientCase, practice } from "@/db/schema";

import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();

/*
 * The practice's clock (U11; U8a's finding 8): U5's screens read the
 * practice's own `time_zone`, not a constant.
 */

describe("the practice's clock", () => {
  it("reads an instant in the zone it is given", () => {
    const at = new Date("2026-10-12T15:40:05Z");
    const london = practiceClock("Europe/London");
    const newYork = practiceClock("America/New_York");

    expect([london.day(at), london.minute(at), london.second(at), london.dayKey(at)]).toEqual([
      "Monday 12 October",
      "16:40",
      "16:40:05",
      "2026-10-12",
    ]);
    expect([newYork.minute(at), newYork.second(at)]).toEqual(["11:40", "11:40:05"]);
  });

  it("is the zone a case's timeline reads its times in", async () => {
    const [made] = await db
      .insert(practice)
      .values({ name: "Clock practice", kind: "judge" })
      .returning({ id: practice.id });
    const practiceId = made!.id;
    await setScheduleSettings(db, { practiceId, leadMinutes: 30, timeZone: "America/New_York" });
    const [kase] = await db
      .insert(patientCase)
      .values({ practiceId, patientName: "Moss", ownerName: "Theo Grant", procedure: "Booster" })
      .returning({ id: patientCase.id });
    await db.insert(auditEvent).values({
      practiceId,
      caseId: kase!.id,
      actor: "system",
      action: "case.opened",
      occurredAt: new Date("2026-10-12T15:40:00Z"),
      detail: { patientName: "Moss" },
    });

    const [row] = await caseTimeline(db, practiceId, kase!.id);

    expect([row!.day, row!.time]).toEqual(["Monday 12 October", "11:40"]);
  });
});
