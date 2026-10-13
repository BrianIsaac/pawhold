import { describe, expect, it } from "vitest";

import { appendAuditEvent } from "@/audit/writer";
import { releaseHold, sweepSchedule } from "@/schedule/agent";
import { loadDay } from "@/schedule/day";

import { dayStamp } from "../../app/(practice)/day/stamp";
import { connectTestDatabase } from "../support/database";
import { startSeededDay } from "../support/schedule";

const { db } = connectTestDatabase();
const MINUTE_MS = 60 * 1000;

/*
 * What keeps the open day live (U8b): a stamp of the practice's latest
 * change of money or schedule, which the page asks after every few seconds,
 * reading the day again when it has moved.
 */

describe("the day's stamp", () => {
  it("moves when the agent holds a slot and when the practice undoes it", async () => {
    const day = await startSeededDay(db);
    const before = await dayStamp(db, day.practiceId);

    await sweepSchedule(db, {
      practiceId: day.practiceId,
      now: new Date(day.due.startsAt.getTime() - 20 * MINUTE_MS),
    });
    const held = await dayStamp(db, day.practiceId);
    const view = await loadDay(db, day.practiceId, {
      now: new Date(day.due.startsAt.getTime() - 20 * MINUTE_MS),
    });
    await releaseHold(db, { practiceId: day.practiceId, proposalId: view.proposals[0]!.id });
    const undone = await dayStamp(db, day.practiceId);

    expect(view.proposals).toHaveLength(1);
    expect(Number(held)).toBeGreaterThan(Number(before));
    expect(Number(undone)).toBeGreaterThan(Number(held));
  });

  it("moves when a case's money state changes", async () => {
    const day = await startSeededDay(db);
    const before = await dayStamp(db, day.practiceId);

    await appendAuditEvent(db, {
      practiceId: day.practiceId,
      caseId: day.dueCaseId,
      actor: "owner",
      action: "hold.authorised",
      moneyStateBefore: "update_awaiting_owner",
      moneyStateAfter: "held",
    });

    expect(Number(await dayStamp(db, day.practiceId))).toBeGreaterThan(Number(before));
  });

  it("stays for an event that changes neither money nor schedule, and for another practice's", async () => {
    const day = await startSeededDay(db);
    const other = await startSeededDay(db);
    const before = await dayStamp(db, day.practiceId);

    await appendAuditEvent(db, {
      practiceId: day.practiceId,
      caseId: day.dueCaseId,
      actor: "vet",
      action: "estimate.drafted",
    });
    await sweepSchedule(db, {
      practiceId: other.practiceId,
      now: new Date(other.due.startsAt.getTime() - 20 * MINUTE_MS),
    });

    expect(await dayStamp(db, day.practiceId)).toBe(before);
  });
});
