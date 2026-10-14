import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { auditEvent, patientCase, webhookEvent } from "@/db/schema";
import { importPriceList } from "@/estimate/price-list";
import { makeEstimateVersion } from "@/estimate/version";
import { reauthoriseHolds } from "@/jobs/reauthorise";
import { createJudgeSessionHandlers } from "@/judge/session";
import { authoriseHold, declineUpdate, orderHold } from "@/money/holds";
import { reconcileWebhookEvent } from "@/money/reconcile";
import { openCase } from "@/practice/cases";
import { approveAndSend } from "@/practice/estimate";
import type { AuditEventRecord } from "@/audit/writer";
import { practiceClock } from "@/practice/time";
import { caseTimeline, describeEvent, DESCRIBED_ACTIONS } from "@/practice/timeline";
import { practice } from "@/db/schema";

import { readSeedPriceList, seedFictionalPractice } from "../../seed/practice";
import { SHOWCASE_CASE } from "../../seed/practice/showcase";
import { connectTestDatabase } from "../support/database";
import { paypalFixtureText } from "../support/fixtures";
import { startPayPalDouble } from "../support/paypal-double";

const { db } = connectTestDatabase();
const paypal = startPayPalDouble();
const DAY_MS = 24 * 60 * 60 * 1000;

let seededPractice: string;
let seededCase: string;

beforeAll(async () => {
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
  seededPractice = ((await started.json()) as { practiceId: string }).practiceId;
  const [kase] = await db
    .select({ id: patientCase.id })
    .from(patientCase)
    .where(
      and(
        eq(patientCase.practiceId, seededPractice),
        eq(patientCase.patientName, SHOWCASE_CASE.patientName),
      ),
    );
  seededCase = kase!.id;
});

/**
 * A practice with the seed's list and a case under Rowan Hale.
 *
 * @returns The practice and the case.
 */
async function freshCase(): Promise<{ practiceId: string; caseId: string }> {
  const [made] = await db
    .insert(practice)
    .values({ name: "Timeline practice", kind: "judge" })
    .returning();
  const practiceId = made!.id;
  await importPriceList(db, {
    practiceId,
    actor: "system",
    sourceName: "seed/practice/price-list.csv",
    csv: readSeedPriceList(),
  });
  const caseId = await openCase(db, {
    practiceId,
    patientName: SHOWCASE_CASE.patientName,
    species: SHOWCASE_CASE.species,
    ownerName: SHOWCASE_CASE.ownerName,
    procedure: SHOWCASE_CASE.procedure,
    vetName: SHOWCASE_CASE.vetName,
  });
  return { practiceId, caseId };
}

/**
 * Makes and sends a version with the vet's approval, as the case page does.
 *
 * @param target - The practice and the case.
 * @param target.practiceId - The practice.
 * @param target.caseId - The case.
 * @param lines - The version's lines.
 * @returns The version's id.
 */
async function approveAndSendLines(
  target: { practiceId: string; caseId: string },
  lines: Parameters<typeof makeEstimateVersion>[1]["lines"],
): Promise<string> {
  const draft = await makeEstimateVersion(db, { ...target, actor: "vet", lines });
  await approveAndSend(db, { practiceId: target.practiceId, versionId: draft.id });
  return draft.id;
}

describe("the case's timeline (plan 3.5, section 6)", () => {
  it("reads every event of the seeded case in order, in plain words, each said to be seeded", async () => {
    const rows = await caseTimeline(db, seededPractice, seededCase);

    expect(rows.map((row) => `${row.who}: ${row.what}`)).toEqual([
      "Rowan Hale: opened the case for Bramble",
      "Rowan Hale: made version 1 of the estimate, £731.00 to £927.00",
      "Rowan Hale: approved version 1",
      "Rowan Hale: sent the estimate to Nadia: £731.00 to £927.00, a hold of £927.00",
      "Owner: opened PayPal's checkout for a hold of £927.00",
      "Owner: authorised a hold of £927.00 (PayPal)",
      "Rowan Hale: made version 2 of the estimate, £951.00 to £1,147.00",
      "Rowan Hale: approved version 2",
      "Rowan Hale: sent an update to Nadia: the estimate is now £951.00 to £1,147.00",
      "Owner: opened PayPal's checkout for a hold of £220.00",
      "Owner: declined the update",
      "pawhold: extended the hold of £927.00: PayPal reauthorised it",
    ]);
    expect(rows.every((row) => row.note === "Seeded for the demo")).toBe(true);
    const times = rows.map((row) => Date.parse(row.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(rows[0]?.time).toMatch(/^\d\d:\d\d$/);
    expect(rows[0]?.day).toMatch(/^\w+day \d{1,2} \w+$/);
  });

  it("keeps the raw event behind the disclosure, with PayPal's ids", async () => {
    const rows = await caseTimeline(db, seededPractice, seededCase);
    const authorised = rows.find((row) => row.action === "hold.authorised")!;

    expect(authorised.details.map((detail) => detail.term)).toEqual(
      expect.arrayContaining([
        "Action",
        "Money state",
        "Amount",
        "PayPal order",
        "PayPal authorisation",
        "Event",
      ]),
    );
    expect(authorised.details.find((detail) => detail.term === "Money state")?.value).toBe(
      "awaiting owner to held",
    );
  });

  it("says when PayPal confirmed the authorisation, from U3's reconciliation of its webhook", async () => {
    const target = await freshCase();
    const versionId = await approveAndSendLines(target, [...SHOWCASE_CASE.estimateLines]);
    const { hold: ordered } = await orderHold(
      { db, paypal: paypal.client() },
      { ...target, versionId },
    );
    paypal.approve(ordered.paypalOrderId);
    const held = await authoriseHold(
      { db, paypal: paypal.client() },
      { ...target, holdId: ordered.id },
    );
    const eventId = `WH-${randomUUID()}`;
    const sample = JSON.parse(
      paypalFixtureText("webhooks/payment-authorization-created.json"),
    ) as Record<string, unknown>;
    const payload = {
      ...sample,
      id: eventId,
      resource: { ...(sample.resource as object), id: held.authorizationId },
    };
    await db.insert(webhookEvent).values({
      eventId,
      eventType: "PAYMENT.AUTHORIZATION.CREATED",
      resourceType: "authorization",
      resourceId: held.authorizationId!,
      transmissionId: randomUUID(),
      transmissionTime: "2026-10-13T09:00:30Z",
      transmissionSig: "c2lnbmF0dXJl",
      certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test",
      authAlgo: "SHA256withRSA",
      verification: "signature",
      rawBody: JSON.stringify(payload),
      payload,
    });
    expect((await reconcileWebhookEvent(db, eventId)).outcome).toBe("reconciled");

    const rows = await caseTimeline(db, target.practiceId, target.caseId);
    const authorised = rows.find((row) => row.action === "hold.authorised")!;
    expect(authorised.what).toMatch(
      /^authorised a hold of £927\.00 \(PayPal, confirmed \d\d:\d\d:\d\d\)$/,
    );
    expect(rows.at(-1)).toMatchObject({
      who: "PayPal",
      what: "webhook PAYMENT.AUTHORIZATION.CREATED verified and matched to the hold",
    });
    expect(rows.at(-1)?.note).toBeUndefined();
  });

  it("names the model and the input's hash of an agent's draft behind the disclosure", async () => {
    const [event] = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.caseId, seededCase))
      .orderBy(asc(auditEvent.id));
    expect(event).toBeDefined();
    const { describeEvent } = await import("@/practice/timeline");
    const row = describeEvent(
      {
        ...event!,
        action: "estimate.drafted",
        actor: "system",
        modelId: "gpt-6.1-sol",
        modelInputSha256: "a".repeat(64),
        modelOutput: { kept: ["GA-DENT"] },
        detail: { versionId: null, number: 1, draftedLines: 4, source: "model", failure: null },
      },
      {
        clock: practiceClock("Europe/London"),
        vetName: "Rowan Hale",
        ownerFirstName: "Nadia",
        patientName: "Bramble",
        confirmations: new Map(),
      },
    );
    expect(row.what).toBe("drafted 4 lines from the notes (model)");
    expect(row.details.map((detail) => detail.term)).toEqual(
      expect.arrayContaining(["Model", "Model input SHA-256", "Model output"]),
    );
  });
});

describe("the timeline's words", () => {
  it("has its own words for every action the code writes for a case", () => {
    const written = new Set<string>();
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (path.endsWith(".ts")) {
          for (const match of readFileSync(path, "utf8").matchAll(
            /"((?:case|estimate|hold|bill|capture|webhook|schedule)\.[a-z_]+)"/g,
          )) {
            written.add(match[1]!);
          }
        }
      }
    };
    walk("src");
    walk("seed");

    expect([...written].filter((action) => !DESCRIBED_ACTIONS.has(action)).sort()).toEqual([]);
  });
});

describe("the seeded story", () => {
  it("is the story U3's own functions write, event for event", async () => {
    const target = await freshCase();
    const deps = { db, paypal: paypal.client() };
    const estimateId = await approveAndSendLines(target, [...SHOWCASE_CASE.estimateLines]);
    const first = await orderHold(deps, { ...target, versionId: estimateId });
    paypal.approve(first.hold.paypalOrderId);
    await authoriseHold(deps, { ...target, holdId: first.hold.id });
    const updateId = await approveAndSendLines(target, [
      ...SHOWCASE_CASE.estimateLines,
      ...SHOWCASE_CASE.updateLines,
    ]);
    await orderHold(deps, { ...target, versionId: updateId });
    await declineUpdate(db, { ...target, actor: "owner" });
    const later = new Date(paypal.clock.now.getTime() + 4 * DAY_MS);
    paypal.clock.now = later;
    await reauthoriseHolds({ ...deps, now: later, practiceId: target.practiceId });

    const story = async (caseId: string) =>
      (
        await db
          .select({ actor: auditEvent.actor, action: auditEvent.action })
          .from(auditEvent)
          .where(eq(auditEvent.caseId, caseId))
          .orderBy(asc(auditEvent.id))
      ).map((event) => `${event.actor} ${event.action}`);
    expect(await story(target.caseId)).toEqual(await story(seededCase));
  });
});

describe("the timeline's words for a judge (U11)", () => {
  /**
   * One of the seeded case's events, made into another to describe.
   *
   * @param change - What the event is instead.
   * @returns The event.
   */
  async function eventLike(change: Partial<AuditEventRecord>): Promise<AuditEventRecord> {
    const [event] = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.caseId, seededCase))
      .orderBy(asc(auditEvent.id));
    return { ...event!, detail: {}, amountPence: null, ...change };
  }

  const context = {
    clock: practiceClock("Europe/London"),
    vetName: "Rowan Hale",
    ownerFirstName: "Ellis",
    patientName: "Juno",
    confirmations: new Map<string, Date>(),
    billSignedOff: null,
    rooms: new Map([["room-1", "Theatre 1"]]),
    patients: new Map([
      ["case-juno", "Juno"],
      ["case-biscuit", "Biscuit"],
    ]),
  };

  it("names an estimate with no range by its one figure", async () => {
    const made = describeEvent(
      await eventLike({
        action: "estimate.version_made",
        detail: { number: 1, lowPence: 9_500, highPence: 9_500 },
      }),
      context,
    );
    expect(made.what).toBe("made version 1 of the estimate, £95.00");
    const sent = describeEvent(
      await eventLike({
        action: "estimate.sent",
        moneyStateAfter: "awaiting_owner",
        amountPence: 9_500,
        detail: { lowPence: 9_500, highPence: 9_500 },
      }),
      context,
    );
    expect(sent.what).toBe("sent the estimate to Ellis: £95.00, a hold of £95.00");
  });

  it("says a hold is flagged when PayPal answered in a status pawhold does not know (U20)", async () => {
    const flagged = describeEvent(
      await eventLike({
        action: "hold.paypal_status_unknown",
        actor: "system",
        detail: { holdId: "hold-1", step: "capture", status: "COMPLETED_LATER" },
      }),
      context,
    );

    expect(`${flagged.who}: ${flagged.what}`).toBe(
      "pawhold: flagged the hold: PayPal answered the capture with COMPLETED_LATER, a status pawhold does not know; check the hold in PayPal",
    );
  });

  it("names the vet who confirmed the bill as who captured and released at discharge", async () => {
    const captured = await eventLike({
      action: "hold.captured",
      actor: "system",
      amountPence: 87_600,
      detail: { releasedPence: 13_400 },
    });
    const row = describeEvent(captured, {
      ...context,
      billSignedOff: { by: "Imogen Shaw", eventId: captured.id - 1 },
    });
    expect(`${row.who}: ${row.what}`).toBe("Imogen Shaw: captured £876.00, £134.00 released");
    expect(describeEvent(captured, context).who).toBe("pawhold");
  });

  it.each([
    [
      "schedule.slot_held",
      "schedule_agent",
      {
        roomId: "room-1",
        startsAt: "2026-10-12T15:40:00.000Z",
        reason: "Ellis hasn't approved the update for Juno.",
      },
      "Schedule agent: held Theatre 1 at 16:40. Ellis hasn't approved the update for Juno.",
    ],
    [
      "schedule.move_proposed",
      "schedule_agent",
      { moveCaseId: "case-biscuit", moveTo: "2026-10-12T15:40:00.000Z" },
      "Schedule agent: proposed moving Biscuit's procedure to 16:40",
    ],
    [
      "schedule.move_applied",
      "vet",
      {
        moveCaseId: "case-biscuit",
        moved: { from: "2026-10-12T16:40:00.000Z", to: "2026-10-12T15:40:00.000Z" },
        heldMoved: { from: "2026-10-12T15:40:00.000Z", to: "2026-10-12T16:40:00.000Z" },
      },
      "Rowan Hale: moved Biscuit's procedure to 16:40; Juno's now starts at 17:40",
    ],
    [
      "schedule.booking_moved",
      "vet",
      { heldCaseId: "case-juno", to: "2026-10-12T15:40:00.000Z" },
      "Rowan Hale: moved Juno's procedure to 16:40, into the slot held for Juno",
    ],
    ["schedule.proposal_dismissed", "vet", {}, "Rowan Hale: dismissed the proposed move"],
    [
      "schedule.slot_released",
      "vet",
      { roomId: "room-1", by: "practice" },
      "Rowan Hale: released the hold on Theatre 1",
    ],
    [
      "schedule.slot_released",
      "schedule_agent",
      { roomId: "room-1", by: "agent" },
      "Schedule agent: released the hold on Theatre 1: the update was answered",
    ],
    [
      "schedule.proposal_withdrawn",
      "schedule_agent",
      { why: "slot_started" },
      "Schedule agent: withdrew the proposed move: the slot had started",
    ],
  ] as const)("words %s for a judge", async (action, actor, detail, words) => {
    const row = describeEvent(await eventLike({ action, actor, detail }), context);
    expect(`${row.who}: ${row.what}`).toBe(words);
  });
});
