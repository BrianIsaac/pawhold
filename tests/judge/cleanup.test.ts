import { and, asc, count, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditEvent, hold, patientCase, practice, session } from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { runHourly } from "@/jobs/hourly";
import { pruneJudgeSessions } from "@/judge/cleanup";
import { SESSION_LIFETIME_MS, startJudgeSession } from "@/judge/session";
import { authoriseHold, orderHold } from "@/money/holds";
import { authorizeOrder } from "@/paypal/orders";

import { seedFictionalPractice } from "../../seed/practice";
import { connectTestDatabase } from "../support/database";
import { startPayPalDouble } from "../support/paypal-double";

const { db } = connectTestDatabase();
const double = startPayPalDouble();
const DAY_MS = 24 * 60 * 60 * 1000;

// The hourly job's other parts run over the whole shared database: at a
// clock before every other file's rows they touch none of them (as U3's
// hourly test does), and the schedule agent's sweep is given nothing to do.
const BEFORE_EVERYTHING = new Date("2026-10-01T00:00:00Z");
const quietSchedule = async () => ({
  held: [],
  moveProposed: [],
  released: [],
  withdrawn: [],
  failed: [],
});

/**
 * A judge's session started `daysAgo` days before `now`, its practice seeded
 * as the doors seed it.
 *
 * @param now - The clean-up's clock.
 * @param daysAgo - How long ago the session started.
 * @returns The session and its practice.
 */
async function judgeSession(now: Date, daysAgo: number) {
  return startJudgeSession(
    { db, seed: seedFictionalPractice, now: () => now.getTime() - daysAgo * DAY_MS },
    "owner",
  );
}

/**
 * A seeded case of the practice, by patient.
 *
 * @param practiceId - The practice.
 * @param patientName - The patient.
 * @returns The case's id.
 */
async function caseOf(practiceId: string, patientName: string): Promise<string> {
  const [found] = await db
    .select({ id: patientCase.id })
    .from(patientCase)
    .where(and(eq(patientCase.practiceId, practiceId), eq(patientCase.patientName, patientName)));
  return found!.id;
}

/**
 * The judge opens PayPal's checkout for a seeded estimate awaiting its owner
 * and approves it at the double.
 *
 * @param practiceId - The practice.
 * @param patientName - The case awaiting its owner.
 * @param kind - How the owner pays.
 * @returns The case and its ordered hold.
 */
async function approvedOrder(
  practiceId: string,
  patientName: string,
  kind: "paypal" | "card" = "paypal",
) {
  const caseId = await caseOf(practiceId, patientName);
  const version = (await caseEstimateVersions(db, practiceId, caseId)).at(-1)!;
  const { hold: ordered } = await orderHold(
    { db, paypal: double.client() },
    { practiceId, caseId, versionId: version.id },
  );
  double.approve(ordered.paypalOrderId, kind);
  return { caseId, hold: ordered };
}

/**
 * The judge authorises a seeded estimate through the owner's page, as U6's
 * page asks U3 to.
 *
 * @param practiceId - The practice.
 * @param patientName - The case awaiting its owner.
 * @returns The case and the authorised hold's id.
 */
async function judgeAuthorises(practiceId: string, patientName: string) {
  const { caseId, hold: ordered } = await approvedOrder(practiceId, patientName);
  await authoriseHold({ db, paypal: double.client() }, { practiceId, caseId, holdId: ordered.id });
  return { caseId, holdId: ordered.id };
}

/**
 * How many rows of each kind a practice holds, the audit trail included.
 *
 * @param practiceId - The practice.
 * @returns The counts.
 */
async function rows(practiceId: string) {
  const [cases] = await db
    .select({ n: count() })
    .from(patientCase)
    .where(eq(patientCase.practiceId, practiceId));
  const [holds] = await db.select({ n: count() }).from(hold).where(eq(hold.practiceId, practiceId));
  const [events] = await db
    .select({ n: count() })
    .from(auditEvent)
    .where(eq(auditEvent.practiceId, practiceId));
  return { cases: cases!.n, holds: holds!.n, events: events!.n };
}

/**
 * The sessions still standing among these.
 *
 * @param ids - The sessions.
 * @returns The ones not pruned.
 */
async function standing(ids: string[]): Promise<string[]> {
  const found = await db.select({ id: session.id }).from(session).where(inArray(session.id, ids));
  return found.map((one) => one.id).sort();
}

// Each test seeds whole practices, as the doors do: more than the default
// five seconds when the whole suite runs at once.
describe(
  "the clean-up in the hourly job (plan 7.4: the seven-day prune)",
  { timeout: 30_000 },
  () => {
    it("the clean-up removes a seven-day-old session and never a showcase case", async () => {
      const now = new Date();
      const old = await judgeSession(now, 8);
      const live = await judgeSession(now, 1);
      const otis = await judgeAuthorises(old.practiceId, "Otis");
      const archie = await approvedOrder(old.practiceId, "Archie", "card");
      // PayPal authorised Archie's order, but its answer never reached pawhold.
      await authorizeOrder(double.client(), archie.hold.paypalOrderId, "lost-answer");
      const [showcase] = await db
        .insert(practice)
        .values({
          name: "Showcase",
          kind: "showcase",
          createdAt: new Date(now.getTime() - 40 * DAY_MS),
        })
        .returning({ id: practice.id });
      await db.transaction((tx) => seedFictionalPractice(tx, showcase!.id));
      const [showcaseSession] = await db
        .insert(session)
        .values({
          practiceId: showcase!.id,
          door: "practice",
          createdAt: new Date(now.getTime() - 40 * DAY_MS),
          expiresAt: new Date(now.getTime() - 40 * DAY_MS + SESSION_LIFETIME_MS),
        })
        .returning({ id: session.id });
      const before = await rows(old.practiceId);
      const showcaseHolds = await db.select().from(hold).where(eq(hold.practiceId, showcase!.id));

      const report = await pruneJudgeSessions({
        db,
        paypal: double.client(),
        now,
        practiceIds: [old.practiceId, live.practiceId, showcase!.id],
      });

      expect(report.pruned).toEqual([old.sessionId]);
      expect(report.waiting).toEqual([]);
      expect(report.voided.sort()).toEqual([otis.holdId, archie.hold.id].sort());
      expect(await standing([old.sessionId, live.sessionId, showcaseSession!.id])).toEqual(
        [live.sessionId, showcaseSession!.id].sort(),
      );
      expect(await db.select().from(hold).where(eq(hold.practiceId, showcase!.id))).toEqual(
        showcaseHolds,
      );

      const held = await db
        .select()
        .from(hold)
        .where(inArray(hold.id, [otis.holdId, archie.hold.id]))
        .orderBy(asc(hold.versionNumber));
      for (const one of held) {
        expect(one.status, one.id).toBe("voided");
        expect(one.closedAt, one.id).not.toBeNull();
        expect(double.authorizations.get(one.authorizationId!)?.status, one.id).toBe("VOIDED");
      }
      const [otisCase] = await db.select().from(patientCase).where(eq(patientCase.id, otis.caseId));
      expect(otisCase?.moneyState).toBe("released");

      const touched = double.requests.map((request) => request.path).join(" ");
      expect(touched).not.toContain("SEEDED");
      const after = await rows(old.practiceId);
      expect(after.cases).toBe(before.cases);
      expect(after.holds).toBe(before.holds);
      expect(after.events).toBeGreaterThan(before.events);

      const events = await db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.practiceId, old.practiceId))
        .orderBy(asc(auditEvent.id));
      const voids = events.filter(
        (event) =>
          event.action === "hold.voided" &&
          (event.detail as { closedBy?: string }).closedBy === "session_end",
      );
      expect(voids.map((event) => [event.caseId, event.actor])).toEqual([
        [otis.caseId, "system"],
        [archie.caseId, "system"],
      ]);
      expect(voids[0]).toMatchObject({
        moneyStateBefore: "held",
        moneyStateAfter: "released",
        amountPence: 101_000,
        detail: expect.objectContaining({ holdId: otis.holdId, closedBy: "session_end" }),
      });
      expect(events.at(-1)).toMatchObject({
        actor: "system",
        action: "judge.session.pruned",
        caseId: null,
        detail: expect.objectContaining({ sessionId: old.sessionId, holdsVoided: 2 }),
      });
    });

    it("changes nothing when run again", async () => {
      const now = new Date();
      const old = await judgeSession(now, 9);
      await judgeAuthorises(old.practiceId, "Otis");
      const scope = { db, paypal: double.client(), now, practiceIds: [old.practiceId] };
      await pruneJudgeSessions(scope);
      const asked = double.requests.length;
      const before = await rows(old.practiceId);

      const again = await pruneJudgeSessions(scope);

      expect(again.pruned).toEqual([]);
      expect(again.voided).toEqual([]);
      expect(double.requests.length).toBe(asked);
      expect(await rows(old.practiceId)).toEqual(before);
    });

    it("without PayPal's credentials, prunes a practice PayPal holds nothing for and keeps one it may", async () => {
      const now = new Date();
      const untouched = await judgeSession(now, 8);
      const opened = await judgeSession(now, 8);
      await approvedOrder(opened.practiceId, "Otis");

      const report = await pruneJudgeSessions({
        db,
        paypal: null,
        now,
        practiceIds: [untouched.practiceId, opened.practiceId],
      });

      expect(report.pruned).toEqual([untouched.sessionId]);
      expect(report.waiting).toEqual([opened.practiceId]);
      expect(await standing([untouched.sessionId, opened.sessionId])).toEqual([opened.sessionId]);
    });

    it("keeps a session whose hold PayPal did not answer about, and prunes it on the next run", async () => {
      const now = new Date();
      const old = await judgeSession(now, 8);
      const otis = await judgeAuthorises(old.practiceId, "Otis");
      double.inject({
        method: "POST",
        path: /\/void$/,
        status: 503,
        body: { name: "SERVICE_UNAVAILABLE", message: "Service Unavailable.", debug_id: "d" },
      });

      const scope = { db, paypal: double.client(), now, practiceIds: [old.practiceId] };

      const first = await pruneJudgeSessions(scope);

      expect(first.pruned).toEqual([]);
      expect(first.waiting).toEqual([old.practiceId]);
      expect(await standing([old.sessionId])).toEqual([old.sessionId]);

      const second = await pruneJudgeSessions(scope);

      expect(second.pruned).toEqual([old.sessionId]);
      expect(second.voided).toEqual([otis.holdId]);
    });

    it("records a hold PayPal had already voided as closed, without voiding it twice", async () => {
      const now = new Date();
      const old = await judgeSession(now, 8);
      const otis = await judgeAuthorises(old.practiceId, "Otis");
      const [row] = await db.select().from(hold).where(eq(hold.id, otis.holdId));
      double.authorizations.get(row!.authorizationId!)!.status = "VOIDED";
      double.inject({
        method: "POST",
        path: /\/void$/,
        status: 422,
        body: {
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed.",
          debug_id: "e",
          details: [{ issue: "AUTHORIZATION_ALREADY_VOIDED" }],
        },
      });

      const report = await pruneJudgeSessions({
        db,
        paypal: double.client(),
        now,
        practiceIds: [old.practiceId],
      });

      expect(report.pruned).toEqual([old.sessionId]);
      expect(double.posts(/\/void$/)).toHaveLength(1);
      const [after] = await db.select().from(hold).where(eq(hold.id, otis.holdId));
      expect(after?.status).toBe("voided");
    });

    it("runs in the hourly job as a part of its own: its failure is reported and the other parts run", async () => {
      const report = await runHourly({
        db,
        paypal: null,
        now: BEFORE_EVERYTHING,
        parts: {
          schedule: quietSchedule,
          sessions: async () => {
            throw new Error("the clean-up failed");
          },
        },
      });

      expect(report.errors).toContain("sessions: the clean-up failed");
      expect(report.webhooks).not.toBeNull();
      expect(report.schedule).not.toBeNull();
      expect(report.sessionsPruned).toBe(0);
    });

    it("reports in the hourly job how many sessions it pruned", async () => {
      const now = new Date();
      const old = await judgeSession(now, 8);

      const report = await runHourly({
        db,
        paypal: null,
        now: BEFORE_EVERYTHING,
        parts: {
          schedule: quietSchedule,
          sessions: (deps) => pruneJudgeSessions({ ...deps, now, practiceIds: [old.practiceId] }),
        },
      });

      expect(report.sessions?.pruned).toEqual([old.sessionId]);
      expect(report.sessionsPruned).toBe(report.sessions!.pruned.length);
    });
  },
);
