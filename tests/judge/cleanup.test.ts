import { and, asc, count, eq, inArray } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { auditEvent, hold, patientCase, practice, session } from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { runHourly } from "@/jobs/hourly";
import { reauthoriseHolds } from "@/jobs/reauthorise";
import { pruneJudgeSessions } from "@/judge/cleanup";
import { SESSION_LIFETIME_MS, startJudgeSession } from "@/judge/session";
import { signOffBill } from "@/money/discharge";
import { authoriseHold, orderHold } from "@/money/holds";
import { createOwnerHandlers } from "@/owner/handlers";
import { ownerLink } from "@/owner/link";
import { resolveOwnerLink } from "@/owner/resolve";
import { authorizeOrder } from "@/paypal/orders";
import { paypalRequestId } from "@/paypal/request-id";

import { seedFictionalPractice } from "../../seed/practice";
import { connectTestDatabase } from "../support/database";
import { startPayPalDouble } from "../support/paypal-double";

const { db } = connectTestDatabase();
const double = startPayPalDouble();
const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET = "test-session-secret-0123456789abcdef-not-real";

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
 * The judge authorises as {@link judgeAuthorises} does, with PayPal's clock
 * at `at`, so the authorisation's 29 days run from then; PayPal's clock is
 * then moved to `now`.
 *
 * @param practiceId - The practice.
 * @param patientName - The case awaiting its owner.
 * @param at - When PayPal authorises.
 * @param now - PayPal's clock after.
 * @returns The case, the authorised hold's id and PayPal's authorisation.
 */
async function judgeAuthorisedAt(practiceId: string, patientName: string, at: Date, now: Date) {
  double.clock.now = at;
  const authorised = await judgeAuthorises(practiceId, patientName);
  double.clock.now = now;
  const [row] = await db.select().from(hold).where(eq(hold.id, authorised.holdId));
  return { ...authorised, authorisation: double.authorizations.get(row!.authorizationId!)! };
}

/**
 * The judge authorises a seeded estimate `daysAgo` days before `now`, and
 * the hourly reauthorisation rule, run on this practice only, reauthorises
 * it on day 5, as U3b's rule did the October demo holds; PayPal's clock is
 * then moved to `now`.
 *
 * @param practiceId - The practice.
 * @param patientName - The case awaiting its owner.
 * @param now - The clean-up's clock.
 * @param daysAgo - How long before `now` PayPal authorised.
 * @returns The case, the hold's id, its original parent and its reauthorisation.
 */
async function judgeReauthorised(
  practiceId: string,
  patientName: string,
  now: Date,
  daysAgo: number,
) {
  const authorised = new Date(now.getTime() - daysAgo * DAY_MS);
  const reauthorisedAt = new Date(authorised.getTime() + 4 * DAY_MS);
  const otis = await judgeAuthorisedAt(practiceId, patientName, authorised, reauthorisedAt);
  const report = await reauthoriseHolds({
    db,
    paypal: double.client(),
    now: reauthorisedAt,
    practiceId,
  });
  expect(report.reauthorised).toEqual([otis.holdId]);
  double.clock.now = now;
  const [row] = await db.select().from(hold).where(eq(hold.id, otis.holdId));
  return {
    caseId: otis.caseId,
    holdId: otis.holdId,
    parent: row!.originalAuthorizationId!,
    reauthorisation: row!.authorizationId!,
  };
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

    it.each(["CREATED", "EXPIRED"] as const)(
      "records a hold whose authorisation ran its 29 days, read back %s, as expired and moves its case as a void does",
      async (readBack) => {
        const now = new Date();
        const old = await judgeSession(now, 31);
        const otis = await judgeAuthorisedAt(
          old.practiceId,
          "Otis",
          new Date(now.getTime() - 30 * DAY_MS),
          now,
        );
        otis.authorisation.status = readBack;
        const scope = { db, paypal: double.client(), now, practiceIds: [old.practiceId] };

        const report = await pruneJudgeSessions(scope);

        expect(report).toEqual({
          pruned: [old.sessionId],
          voided: [],
          expired: [otis.holdId],
          waiting: [],
        });
        expect(double.posts(/\/void$/)).toHaveLength(1);
        const [after] = await db.select().from(hold).where(eq(hold.id, otis.holdId));
        expect(after?.status).toBe("expired");
        expect(after?.closedAt).not.toBeNull();
        const [otisCase] = await db
          .select()
          .from(patientCase)
          .where(eq(patientCase.id, otis.caseId));
        expect(otisCase?.moneyState).toBe("released");

        const events = await db
          .select()
          .from(auditEvent)
          .where(eq(auditEvent.practiceId, old.practiceId))
          .orderBy(asc(auditEvent.id));
        const closing = events.filter(
          (event) => (event.detail as { holdId?: string }).holdId === otis.holdId,
        );
        expect(closing.map((event) => event.action)).toEqual([
          "hold.ordered",
          "hold.authorised",
          "hold.expired",
        ]);
        expect(closing.slice(-1)).toEqual([
          expect.objectContaining({
            caseId: otis.caseId,
            actor: "system",
            moneyStateBefore: "held",
            moneyStateAfter: "released",
            amountPence: 101_000,
            paypalAuthorizationId: otis.authorisation.id,
            paypalDebugId: "double422",
            detail: {
              holdId: otis.holdId,
              closedBy: "session_end",
              reason:
                "PayPal refused the void: the authorisation had run its 29 days and expired, and PayPal had released the money itself",
              releasedPence: 101_000,
              issues: ["AUTHORIZATION_EXPIRED"],
            },
          }),
        ]);
        expect(events.at(-1)).toMatchObject({
          action: "judge.session.pruned",
          detail: expect.objectContaining({ holdsVoided: 0, holdsExpired: 1 }),
        });

        const asked = double.requests.length;
        expect(await pruneJudgeSessions(scope)).toEqual({
          pruned: [],
          voided: [],
          expired: [],
          waiting: [],
        });
        expect(double.requests.length).toBe(asked);
      },
    );

    it.each([
      ["CAPTURED", "past its 29 days", 30, "PREVIOUSLY_CAPTURED", "a7b0de7cb97ad"],
      ["PARTIALLY_CAPTURED", "past its 29 days", 30, "AUTHORIZATION_EXPIRED", "double422"],
      ["CREATED", "inside its 29 days", 0, "AUTHORIZATION_STILL_HELD", "g"],
      [
        "PENDING_LATER",
        "past its 29 days, a status PayPal's schema does not list",
        30,
        "AUTHORIZATION_EXPIRED",
        "double422",
      ],
    ] as const)(
      "keeps a hold PayPal refuses to void whose authorisation reads %s, %s, and the session with it",
      async (readBack, _when, daysAgo, issue, debugId) => {
        const now = new Date();
        const old = await judgeSession(now, 8);
        const otis = await judgeAuthorisedAt(
          old.practiceId,
          "Otis",
          new Date(now.getTime() - daysAgo * DAY_MS),
          now,
        );
        (otis.authorisation as { status: string }).status = readBack;
        if (daysAgo === 0) {
          double.inject({
            method: "POST",
            path: /\/void$/,
            status: 422,
            body: {
              name: "UNPROCESSABLE_ENTITY",
              message: "The requested action could not be performed.",
              debug_id: "g",
              details: [{ issue: "AUTHORIZATION_STILL_HELD" }],
            },
          });
        }
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        const report = await pruneJudgeSessions({
          db,
          paypal: double.client(),
          now,
          practiceIds: [old.practiceId],
        });

        expect(report).toEqual({ pruned: [], voided: [], expired: [], waiting: [old.practiceId] });
        expect(await standing([old.sessionId])).toEqual([old.sessionId]);
        const [after] = await db.select().from(hold).where(eq(hold.id, otis.holdId));
        expect(after?.status).toBe("authorised");
        // The refusal's issue name and PayPal's debug id are logged beside the
        // message, since the message alone never says why PayPal refused.
        expect(logged).toHaveBeenCalledWith("pawhold: the clean-up could not release a hold", {
          holdId: otis.holdId,
          error: expect.stringContaining(
            `(PayPal reads authorisation ${otis.authorisation.id} ${readBack}, expiring `,
          ),
          issues: [issue],
          debugId,
        });
        logged.mockRestore();
        const closing = (
          await db
            .select({ action: auditEvent.action, detail: auditEvent.detail })
            .from(auditEvent)
            .where(eq(auditEvent.caseId, otis.caseId))
        )
          .filter((event) => (event.detail as { holdId?: string }).holdId === otis.holdId)
          .map((event) => event.action);
        expect(closing).toEqual(["hold.ordered", "hold.authorised"]);
      },
    );

    it("records an authorisation pawhold never saw, which ran its 29 days, as expired on its hold", async () => {
      const now = new Date();
      const old = await judgeSession(now, 31);
      double.clock.now = new Date(now.getTime() - 30 * DAY_MS);
      const archie = await approvedOrder(old.practiceId, "Archie", "card");
      // PayPal authorised Archie's order, but its answer never reached pawhold.
      await authorizeOrder(double.client(), archie.hold.paypalOrderId, "lost-answer");
      double.clock.now = now;

      const report = await pruneJudgeSessions({
        db,
        paypal: double.client(),
        now,
        practiceIds: [old.practiceId],
      });

      expect(report).toEqual({
        pruned: [old.sessionId],
        voided: [],
        expired: [archie.hold.id],
        waiting: [],
      });
      const authorizationId = double.orders.get(archie.hold.paypalOrderId)!.authorizationId!;
      const [after] = await db.select().from(hold).where(eq(hold.id, archie.hold.id));
      expect(after).toMatchObject({ status: "expired", authorizationId, paymentKind: "card" });
      const [expired] = await db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.caseId, archie.caseId), eq(auditEvent.action, "hold.expired")));
      expect(expired).toMatchObject({
        paypalAuthorizationId: authorizationId,
        detail: expect.objectContaining({
          closedBy: "session_end",
          reason: expect.stringMatching(/expired.*unknown to pawhold$/),
          issues: ["AUTHORIZATION_EXPIRED"],
        }),
      });
    });

    it("closes a reauthorised hold voided on the first run, through its original parent, the audit naming the parent and its reauthorisation", async () => {
      const now = new Date();
      const old = await judgeSession(now, 8);
      const otis = await judgeReauthorised(old.practiceId, "Otis", now, 7);
      const scope = { db, paypal: double.client(), now, practiceIds: [old.practiceId] };

      const report = await pruneJudgeSessions(scope);

      expect(report).toEqual({
        pruned: [old.sessionId],
        voided: [otis.holdId],
        expired: [],
        waiting: [],
      });
      const voids = double.posts(/\/void$/);
      expect(voids.map((post) => post.path)).toEqual([
        `/v2/payments/authorizations/${otis.parent}/void`,
      ]);
      expect(voids[0]!.headers["paypal-request-id"]).toBe(
        paypalRequestId({
          caseId: otis.caseId,
          holdId: otis.holdId,
          step: "void.session_end.parent",
        }),
      );
      expect(double.authorizations.get(otis.parent)!.status).toBe("VOIDED");
      expect(double.authorizations.get(otis.reauthorisation)!.status).toBe("VOIDED");
      const [after] = await db.select().from(hold).where(eq(hold.id, otis.holdId));
      expect(after).toMatchObject({
        status: "voided",
        authorizationId: otis.reauthorisation,
        originalAuthorizationId: otis.parent,
      });
      const [otisCase] = await db.select().from(patientCase).where(eq(patientCase.id, otis.caseId));
      expect(otisCase?.moneyState).toBe("released");

      const closing = (
        await db
          .select()
          .from(auditEvent)
          .where(eq(auditEvent.caseId, otis.caseId))
          .orderBy(asc(auditEvent.id))
      ).filter((event) => (event.detail as { holdId?: string }).holdId === otis.holdId);
      expect(closing.map((event) => event.action)).toEqual([
        "hold.ordered",
        "hold.authorised",
        "hold.reauthorised",
        "hold.voided",
      ]);
      expect(closing.at(-1)).toMatchObject({
        actor: "system",
        moneyStateBefore: "held",
        moneyStateAfter: "released",
        amountPence: 101_000,
        paypalAuthorizationId: otis.parent,
        detail: {
          holdId: otis.holdId,
          closedBy: "session_end",
          reason: "the judge's session ended after seven days",
          releasedPence: 101_000,
          reauthorizationId: otis.reauthorisation,
        },
      });

      const asked = double.requests.length;
      expect(await pruneJudgeSessions(scope)).toEqual({
        pruned: [],
        voided: [],
        expired: [],
        waiting: [],
      });
      expect(double.requests.length).toBe(asked);
    });

    it("reads back the original parent of a reauthorised hold whose void PayPal refuses, and records its expiry naming both", async () => {
      const now = new Date();
      const old = await judgeSession(now, 31);
      const otis = await judgeReauthorised(old.practiceId, "Otis", now, 30);

      const report = await pruneJudgeSessions({
        db,
        paypal: double.client(),
        now,
        practiceIds: [old.practiceId],
      });

      expect(report).toEqual({
        pruned: [old.sessionId],
        voided: [],
        expired: [otis.holdId],
        waiting: [],
      });
      const asked = double.requests.filter((request) =>
        request.path.startsWith("/v2/payments/authorizations/"),
      );
      expect(asked.slice(-2).map((request) => `${request.method} ${request.path}`)).toEqual([
        `POST /v2/payments/authorizations/${otis.parent}/void`,
        `GET /v2/payments/authorizations/${otis.parent}`,
      ]);
      const [expired] = await db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.caseId, otis.caseId), eq(auditEvent.action, "hold.expired")));
      expect(expired).toMatchObject({
        paypalAuthorizationId: otis.parent,
        paypalDebugId: "double422",
        detail: expect.objectContaining({
          closedBy: "session_end",
          issues: ["AUTHORIZATION_EXPIRED"],
          reauthorizationId: otis.reauthorisation,
        }),
      });
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

    it("ends an owner's link with its practice: a pruned practice's link asks the practice and holds nothing", async () => {
      const now = new Date();
      const old = await judgeSession(now, 8);
      const caseId = await caseOf(old.practiceId, "Otis");
      const version = (await caseEstimateVersions(db, old.practiceId, caseId)).at(-1)!;
      const link = await ownerLink(
        db,
        { practiceId: old.practiceId, caseId, versionId: version.id },
        { secret: SECRET, now },
      );
      await pruneJudgeSessions({ db, paypal: double.client(), now, practiceIds: [old.practiceId] });

      expect(await resolveOwnerLink(db, link.token, { secret: SECRET, now })).toEqual({
        kind: "ask_the_practice",
        practiceName: "Hollins Lane Veterinary Surgery",
      });
      const owner = createOwnerHandlers({ db, paypal: () => double.client(), secret: SECRET });
      const ordered = await owner.order(
        new Request(`https://pawhold.test${link.path}/order`, { method: "POST" }),
        link.token,
      );
      expect(ordered.status).toBe(404);
      expect(double.posts(/\/v2\/checkout\/orders$/)).toEqual([]);
    });

    it("voids a hold authorised after its practice was pruned, on the next run", async () => {
      const now = new Date();
      const old = await judgeSession(now, 8);
      const { caseId, hold: ordered } = await approvedOrder(old.practiceId, "Otis");
      const scope = { db, paypal: double.client(), now, practiceIds: [old.practiceId] };
      // The owner's authorise was already in flight when the clean-up ran:
      // PayPal held nothing yet, so the session was pruned.
      expect((await pruneJudgeSessions(scope)).pruned).toEqual([old.sessionId]);
      await authoriseHold(
        { db, paypal: double.client() },
        { practiceId: old.practiceId, caseId, holdId: ordered.id },
      );

      const report = await pruneJudgeSessions(scope);

      expect(report.voided).toEqual([ordered.id]);
      const [row] = await db.select().from(hold).where(eq(hold.id, ordered.id));
      expect(row?.status).toBe("voided");
      expect(double.authorizations.get(row!.authorizationId!)?.status).toBe("VOIDED");
      expect((await pruneJudgeSessions(scope)).voided).toEqual([]);
    });

    it("takes an order PayPal no longer has as holding nothing, so it does not keep the session", async () => {
      const now = new Date();
      const old = await judgeSession(now, 8);
      await approvedOrder(old.practiceId, "Otis");
      double.inject({
        method: "GET",
        path: /\/v2\/checkout\/orders\//,
        status: 404,
        body: {
          name: "RESOURCE_NOT_FOUND",
          message: "The specified resource does not exist.",
          debug_id: "f",
          details: [{ issue: "INVALID_RESOURCE_ID" }],
        },
      });

      const report = await pruneJudgeSessions({
        db,
        paypal: double.client(),
        now,
        practiceIds: [old.practiceId],
      });

      expect(report.pruned).toEqual([old.sessionId]);
      expect(report.waiting).toEqual([]);
    });

    it("leaves a hold whose bill is signed off to its discharge, and keeps the session until then", async () => {
      const now = new Date();
      const old = await judgeSession(now, 8);
      const otis = await judgeAuthorises(old.practiceId, "Otis");
      const version = (await caseEstimateVersions(db, old.practiceId, otis.caseId)).at(-1)!;
      await signOffBill(db, {
        practiceId: old.practiceId,
        caseId: otis.caseId,
        actor: "vet",
        lines: [{ estimateLineId: version.lines[0]!.id, quantity: 1 }],
      });

      const report = await pruneJudgeSessions({
        db,
        paypal: double.client(),
        now,
        practiceIds: [old.practiceId],
      });

      expect(report).toEqual({ pruned: [], voided: [], expired: [], waiting: [old.practiceId] });
      expect(double.posts(/\/void$/)).toEqual([]);
    });
  },
);
