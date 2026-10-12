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
import { caseTimeline, DESCRIBED_ACTIONS } from "@/practice/timeline";
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
            /"((?:case|estimate|hold|bill|capture|webhook)\.[a-z_]+)"/g,
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
