import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { checkExplanation, checkOwnerWording, findSpan } from "@/agent/guardrails";
import { auditEvent, estimateSource, patientCase } from "@/db/schema";
import { checkEstimateTrigger } from "@/estimate/trigger";
import { caseEstimateVersions } from "@/estimate/version";
import { createJudgeSessionHandlers } from "@/judge/session";
import { reauthoriseHolds } from "@/jobs/reauthorise";
import { caseMoney } from "@/money/view";
import type { PayPalClient } from "@/paypal/client";
import { todaysCases } from "@/practice/cases";

import { seedFictionalPractice } from "../../seed/practice";
import { SHOWCASE_CASE } from "../../seed/practice/showcase";
import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();
const ORIGIN = "https://pawhold.test";
const DAY_MS = 24 * 60 * 60 * 1000;

let practiceId: string;
let caseId: string;

beforeAll(async () => {
  const handlers = createJudgeSessionHandlers({
    db,
    secret: "test-session-secret-0123456789abcdef-not-real",
    seed: seedFictionalPractice,
  });
  const started = await handlers.POST(
    new Request(`${ORIGIN}/api/judge/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ door: "practice" }),
    }),
  );
  practiceId = ((await started.json()) as { practiceId: string }).practiceId;
  const [kase] = await db
    .select({ id: patientCase.id })
    .from(patientCase)
    .where(eq(patientCase.practiceId, practiceId));
  caseId = kase!.id;
});

describe("the seeded showcase case", () => {
  it("is on today's list: a sent estimate, held, its update declined, its hold extended", async () => {
    const [listed] = await todaysCases(db, practiceId);

    expect(listed).toMatchObject({
      id: caseId,
      patientName: SHOWCASE_CASE.patientName,
      ownerName: SHOWCASE_CASE.ownerName,
      vetName: SHOWCASE_CASE.vetName,
      chips: [
        { tone: "update_declined", label: "Update declined" },
        { tone: "extended", label: "Hold extended" },
      ],
      next: "Call Nadia about the update",
    });
  });

  it("holds the estimate's top on a reauthorised PayPal hold, the update's hold declined", async () => {
    const money = await caseMoney(db, practiceId, caseId);

    expect(money.state).toBe("update_declined");
    expect(money.heldPence).toBe(92_700);
    const [first, update] = money.holds;
    expect(first).toMatchObject({
      versionNumber: 1,
      status: "authorised",
      paymentKind: "paypal",
      amount: { pence: 92_700, currency: "GBP" },
    });
    expect(first?.reauthorisedAt).not.toBeNull();
    expect(first?.authorizationId).not.toBe(first?.originalAuthorizationId);
    expect(update).toMatchObject({
      versionNumber: 2,
      status: "declined",
      heldBeforePence: 92_700,
      amount: { pence: 22_000, currency: "GBP" },
    });
  });

  it("was reauthorised from day 4, as the rule does (plan 3.2)", async () => {
    const [first] = (await caseMoney(db, practiceId, caseId)).holds;
    const elapsed = first!.reauthorisedAt!.getTime() - first!.authorisedAt!.getTime();

    expect(elapsed).toBeGreaterThanOrEqual(3 * DAY_MS);
    expect(elapsed).toBeLessThan(29 * DAY_MS);
    expect(first!.reauthorisedAt!.getTime()).toBeLessThan(Date.now());
  });

  it("keeps the notes and the finding its versions were drafted from", async () => {
    const sources = await db
      .select()
      .from(estimateSource)
      .where(eq(estimateSource.caseId, caseId))
      .orderBy(asc(estimateSource.createdAt));
    const versions = await caseEstimateVersions(db, practiceId, caseId);

    expect(versions.map((version) => version.sentAt !== null)).toEqual([true, true]);
    expect(sources.map((source) => [source.versionId, source.kind])).toEqual([
      [versions[0]!.id, "notes"],
      [versions[1]!.id, "finding"],
    ]);
    expect(sources[0]?.text).toBe(SHOWCASE_CASE.notes);
    expect(sources[1]?.text).toBe(SHOWCASE_CASE.finding);
    expect(sources[1]?.explanation).toBe(SHOWCASE_CASE.explanation);
  });

  it("is what the agent's guardrails would let through: every span in its words, every wording clean", async () => {
    const [estimate, update] = await caseEstimateVersions(db, practiceId, caseId);
    for (const line of estimate!.lines) {
      expect(findSpan(SHOWCASE_CASE.notes, line.notesSpan!), line.code).not.toBeNull();
      expect(checkOwnerWording(line.ownerWording!), line.code).toBeNull();
    }
    for (const line of update!.lines.slice(estimate!.lines.length)) {
      expect(findSpan(SHOWCASE_CASE.finding, line.notesSpan!), line.code).not.toBeNull();
      expect(checkOwnerWording(line.ownerWording!), line.code).toBeNull();
    }
    expect(checkExplanation(SHOWCASE_CASE.explanation, SHOWCASE_CASE.finding)).toBeNull();
  });

  it("prices its estimate £731.00 to £927.00 and its update meets the Order's trigger", async () => {
    const [estimate, update] = await caseEstimateVersions(db, practiceId, caseId);

    expect(estimate?.totals).toEqual({ lowPence: 73_100, highPence: 92_700 });
    expect(update?.totals.highPence).toBe(114_700);
    const trigger = await checkEstimateTrigger(db, { practiceId, versionId: update!.id });
    expect(trigger).toMatchObject({ increasePence: 22_000, met: true });
  });

  it("tells its story on the audit trail in order, every event said to be seeded (D16)", async () => {
    const events = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.caseId, caseId))
      .orderBy(asc(auditEvent.id));

    expect(events.map((event) => `${event.actor} ${event.action}`)).toEqual([
      "vet case.opened",
      "vet estimate.version_made",
      "vet estimate.approved",
      "vet estimate.sent",
      "owner hold.ordered",
      "owner hold.authorised",
      "vet estimate.version_made",
      "vet estimate.approved",
      "vet estimate.sent",
      "owner hold.ordered",
      "owner estimate.update_declined",
      "system hold.reauthorised",
    ]);
    for (const event of events) {
      expect(event.detail, event.action).toMatchObject({ seeded: true });
    }
    const times = events.map((event) => event.occurredAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times.at(-1)!).toBeLessThan(Date.now());
    const approval = events.find((event) => event.action === "estimate.approved");
    expect(approval?.detail).toMatchObject({ vetName: SHOWCASE_CASE.vetName });
  });

  it("is never sent to PayPal by the hourly rule: once its new honour period ends it is flagged", async () => {
    const asked: string[] = [];
    const refusing: PayPalClient = {
      get: async (path) => {
        asked.push(path);
        throw new Error("the seeded hold must never reach PayPal");
      },
      post: async (path) => {
        asked.push(path);
        throw new Error("the seeded hold must never reach PayPal");
      },
    };

    const report = await reauthoriseHolds({
      db,
      paypal: refusing,
      practiceId,
      now: new Date(Date.now() + 3 * DAY_MS),
    });

    expect(asked).toEqual([]);
    expect(report.reauthorised).toEqual([]);
    expect(report.flagged).toHaveLength(1);
    const chips = (await todaysCases(db, practiceId))[0]?.chips.map((chip) => chip.label);
    expect(chips).toEqual(["Update declined", "Hold extended", "Honour period over"]);
  });
});
