import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditEvent, patientCase, practice, priceCategory } from "@/db/schema";
import { currentPriceList, parsePriceList } from "@/estimate/price-list";
import { makeEstimateVersion } from "@/estimate/version";
import { createJudgeSessionHandlers } from "@/judge/session";

import { FICTIONAL_PRACTICE, readSeedPriceList, seedFictionalPractice } from "../../seed/practice";
import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();
const SECRET = "test-session-secret-0123456789abcdef-not-real";
const ORIGIN = "https://pawhold.test";

/**
 * Starts a judge session with the fictional practice's seed, as the
 * application wires it.
 *
 * @returns The new practice's id.
 */
async function startSeededSession(): Promise<string> {
  const handlers = createJudgeSessionHandlers({ db, secret: SECRET, seed: seedFictionalPractice });
  const started = await handlers.POST(
    new Request(`${ORIGIN}/api/judge/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ door: "practice" }),
    }),
  );
  expect(started.status).toBe(201);
  return ((await started.json()) as { practiceId: string }).practiceId;
}

describe("the fictional practice's seed (D2)", () => {
  it("the seed loads and every item is priced", async () => {
    const practiceId = await startSeededSession();

    const list = await currentPriceList(db, practiceId);
    const items = [...(list?.items.values() ?? [])];

    expect(items.length).toBeGreaterThanOrEqual(75);
    expect(items.length).toBe(parsePriceList(readSeedPriceList()).length);
    for (const item of items) {
      expect(item.unitPricePence, item.code).toBeGreaterThan(0);
      expect(Number.isInteger(item.unitPricePence), item.code).toBe(true);
    }
    expect(new Set(items.map((item) => item.category))).toEqual(new Set(priceCategory.enumValues));
    expect(list?.currencyCode).toBe("GBP");
  });

  it("names the practice and keeps the Order's default threshold", async () => {
    const practiceId = await startSeededSession();

    const [seeded] = await db.select().from(practice).where(eq(practice.id, practiceId));

    expect(seeded).toMatchObject({
      name: FICTIONAL_PRACTICE.name,
      monetaryThresholdPence: 50_000,
    });
    const actions = await db
      .select({ action: auditEvent.action, actor: auditEvent.actor })
      .from(auditEvent)
      .where(eq(auditEvent.practiceId, practiceId));
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: "pricelist.imported", actor: "system" },
        { action: "practice.seeded", actor: "system" },
        { action: "judge.session.started", actor: "system" },
      ]),
    );
  });

  it("prices plan 3.4's dental notes from its list", async () => {
    const practiceId = await startSeededSession();
    const [kase] = await db
      .insert(patientCase)
      .values({
        practiceId,
        patientName: "Biscuit",
        species: "dog",
        ownerName: "A. Owner",
        procedure: "Dental",
      })
      .returning();

    const draft = await makeEstimateVersion(db, {
      practiceId,
      caseId: kase!.id,
      actor: "vet",
      lines: [
        { code: "GA-DENT", quantityLow: 1, quantityHigh: 1, notesSpan: "GA" },
        { code: "DEN-SP", quantityLow: 1, quantityHigh: 1, notesSpan: "dental scale and polish" },
        {
          code: "DEN-EXT-SG",
          quantityLow: 0,
          quantityHigh: 2,
          dependsOn: "only if extractions are needed",
          notesSpan: "probable two extractions upper PM",
        },
        { code: "LAB-PRE", quantityLow: 1, quantityHigh: 1, notesSpan: "pre-op bloods" },
      ],
    });

    expect(draft.lines).toHaveLength(4);
    expect(draft.totals.lowPence).toBeGreaterThan(0);
    expect(draft.totals.highPence).toBeGreaterThan(draft.totals.lowPence);
  });

  it("gives each judge a practice of their own, with a list of its own", async () => {
    const first = await startSeededSession();
    const second = await startSeededSession();

    expect((await currentPriceList(db, first))?.id).not.toBe(
      (await currentPriceList(db, second))?.id,
    );
  });

  it("gives every seeded case its animal's species, as its notes name it (U17)", async () => {
    const practiceId = await startSeededSession();

    const cases = await db
      .select({ patientName: patientCase.patientName, species: patientCase.species })
      .from(patientCase)
      .where(eq(patientCase.practiceId, practiceId))
      .orderBy(patientCase.patientName);

    expect(Object.fromEntries(cases.map((one) => [one.patientName, one.species]))).toEqual({
      Archie: "dog",
      Biscuit: "dog",
      Bramble: "dog",
      Clover: "cat",
      Hazel: "dog",
      Juno: "dog",
      Luna: "dog",
      Milo: "cat",
      Moss: "other",
      Otis: "dog",
      Pip: "dog",
      Poppy: "cat",
      Rufus: "dog",
      Teddy: "dog",
      Willow: "dog",
    });
  });
});
