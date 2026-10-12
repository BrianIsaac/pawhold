import { describe, expect, it } from "vitest";

import { runHourly } from "@/jobs/hourly";
import type { CleanupReport } from "@/judge/cleanup";
import { sweepSchedule, type SweepReport } from "@/schedule/agent";

import { connectTestDatabase } from "../support/database";
import { startPayPalDouble } from "../support/paypal-double";
import { startSeededDay } from "../support/schedule";

const database = connectTestDatabase();
const paypal = startPayPalDouble();

// A clock before every hold and webhook the other files make, so this run
// touches none of theirs.
const BEFORE_EVERYTHING = new Date("2026-10-01T00:00:00Z");

const NOTHING_SWEPT: SweepReport = {
  held: [],
  moveProposed: [],
  released: [],
  withdrawn: [],
  failed: [],
};

// The schedule agent's sweep releases any practice's answered holds whatever
// the clock, so these runs give it a part that sweeps nothing of the other
// files'; the last test runs the real sweep on a practice of its own.
const quietSchedule = async (): Promise<SweepReport> => NOTHING_SWEPT;

// The judge-session clean-up prunes any practice's ended sessions, whatever
// the clock: every run here is given a part that prunes nothing of the other
// files'; tests/judge/cleanup.test.ts runs the real one on practices of its own.
const quietSessions = async (): Promise<CleanupReport> => ({ pruned: [], voided: [], waiting: [] });

describe("the hourly job (plan 7.3: the reauthorisation rule; U3's webhook sweep; U8a's schedule agent)", () => {
  it("runs the reauthorisation rule, the webhook sweep and the schedule agent, and reports what each did", async () => {
    const report = await runHourly({
      db: database.db,
      paypal: paypal.client(),
      now: BEFORE_EVERYTHING,
      parts: { schedule: quietSchedule, sessions: quietSessions },
    });

    expect(report).toEqual({
      databaseReached: true,
      reauthorisation: { reauthorised: [], flagged: [], tooSoon: [], refused: [], failed: [] },
      discharges: { resumed: [], failed: [] },
      webhooks: { reconciled: 0, flagged: 0, pending: 0, failed: 0 },
      schedule: NOTHING_SWEPT,
      sessions: { pruned: [], voided: [], waiting: [] },
      sessionsPruned: 0,
      errors: [],
    });
  });

  it("runs every part even when one fails, and reports the failure", async () => {
    const report = await runHourly({
      db: database.db,
      paypal: paypal.client(),
      now: BEFORE_EVERYTHING,
      parts: {
        reauthorisation: () => Promise.reject(new Error("the rule broke")),
        schedule: quietSchedule,
        sessions: quietSessions,
      },
    });

    expect(report.reauthorisation).toBeNull();
    expect(report.errors).toEqual(["reauthorisation: the rule broke"]);
    expect(report.discharges).toEqual({ resumed: [], failed: [] });
    expect(report.webhooks).toEqual({ reconciled: 0, flagged: 0, pending: 0, failed: 0 });
    expect(report.schedule).toEqual(NOTHING_SWEPT);
  });

  it("isolates the schedule agent: its failure is reported and the money parts still run", async () => {
    const report = await runHourly({
      db: database.db,
      paypal: paypal.client(),
      now: BEFORE_EVERYTHING,
      parts: {
        schedule: () => Promise.reject(new Error("the sweep broke")),
        sessions: quietSessions,
      },
    });

    expect(report.schedule).toBeNull();
    expect(report.errors).toEqual(["schedule: the sweep broke"]);
    expect(report.reauthorisation).not.toBeNull();
    expect(report.webhooks).toEqual({ reconciled: 0, flagged: 0, pending: 0, failed: 0 });
  });

  it("skips the reauthorisation rule, saying so, when PayPal's credentials are not set", async () => {
    const report = await runHourly({
      db: database.db,
      paypal: null,
      now: BEFORE_EVERYTHING,
      parts: { schedule: quietSchedule, sessions: quietSessions },
    });

    expect(report.reauthorisation).toBeNull();
    expect(report.discharges).toBeNull();
    expect(report.webhooks).toEqual({ reconciled: 0, flagged: 0, pending: 0, failed: 0 });
  });

  it("runs the schedule agent without PayPal's credentials, given the database and the clock", async () => {
    const day = await startSeededDay(database.db);
    const now = new Date(day.due.startsAt.getTime() - 30 * 60 * 1000);
    const asked: Date[] = [];

    const report = await runHourly({
      db: database.db,
      paypal: null,
      now,
      parts: {
        schedule: (db, clock) => {
          asked.push(clock);
          return sweepSchedule(db, { now: clock, practiceId: day.practiceId });
        },
        sessions: quietSessions,
      },
    });

    expect(asked).toEqual([now]);
    expect(report.schedule?.held).toHaveLength(1);
    expect(report.schedule?.moveProposed).toEqual(report.schedule?.held);
  });
});
