import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent, patientCase, practice } from "@/db/schema";
import { importPriceList } from "@/estimate/price-list";
import { checkEstimateTrigger } from "@/estimate/trigger";
import {
  caseEstimateVersions,
  EstimateError,
  estimateDelta,
  type EstimateLineInput,
  linesOf,
  loadEstimateVersion,
  makeEstimateVersion,
  replaceDraftLines,
  sendEstimateVersion,
} from "@/estimate/version";

import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();

const PRICES = [
  "code,name,category,unit,unit_price_pence",
  "CON-STD,Consultation,consultation,consultation,4800",
  "GA-DENT,General anaesthetic for dental work,anaesthesia,procedure,32000",
  "DEN-SP,Dental scale and polish,procedure,procedure,18500",
  "DEN-EXT,Tooth extraction,procedure,tooth,9800",
  "LAB-PRE,Pre-anaesthetic blood screen,laboratory,test,7200",
].join("\n");

let practiceId: string;
let caseId: string;

beforeEach(async () => {
  const [made] = await db
    .insert(practice)
    .values({ name: "Version practice", kind: "judge" })
    .returning();
  practiceId = made!.id;
  await importPriceList(db, { practiceId, actor: "system", sourceName: "prices.csv", csv: PRICES });
  const [kase] = await db
    .insert(patientCase)
    .values({ practiceId, patientName: "Biscuit", ownerName: "A. Owner", procedure: "Dental" })
    .returning();
  caseId = kase!.id;
});

const DENTAL: EstimateLineInput[] = [
  { code: "GA-DENT", quantityLow: 1, quantityHigh: 1, notesSpan: "GA" },
  { code: "DEN-SP", quantityLow: 1, quantityHigh: 1, notesSpan: "dental scale and polish" },
  {
    code: "DEN-EXT",
    quantityLow: 0,
    quantityHigh: 2,
    dependsOn: "only if extractions are needed",
    notesSpan: "probable two extractions upper PM",
    ownerWording: "Removing up to two damaged teeth, if needed",
  },
  { code: "LAB-PRE", quantityLow: 1, quantityHigh: 1, notesSpan: "pre-op bloods" },
];

/**
 * The reason an estimate operation was refused.
 *
 * @param operation - The operation.
 * @returns The refusal.
 * @throws Error when the operation succeeds.
 */
async function refusal(operation: Promise<unknown>): Promise<EstimateError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof EstimateError) {
      return error;
    }
    throw error;
  }
  throw new Error("the operation was not refused");
}

describe("an estimate version (plan 3.3)", () => {
  it("prices every line's money from the list, in pence, with the total as a range", async () => {
    const version = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: DENTAL,
    });

    expect(version.number).toBe(1);
    expect(version.sentAt).toBeNull();
    expect(
      version.lines.map((line) => [line.code, line.unitPricePence, line.lowPence, line.highPence]),
    ).toEqual([
      ["GA-DENT", 32_000, 32_000, 32_000],
      ["DEN-SP", 18_500, 18_500, 18_500],
      ["DEN-EXT", 9_800, 0, 19_600],
      ["LAB-PRE", 7_200, 7_200, 7_200],
    ]);
    expect(version.totals).toEqual({ lowPence: 57_700, highPence: 77_300 });
    expect(version.currency).toBe("GBP");
    expect(version.lines[2]).toMatchObject({
      name: "Tooth extraction",
      unit: "tooth",
      dependsOn: "only if extractions are needed",
      notesSpan: "probable two extractions upper PM",
      ownerWording: "Removing up to two damaged teeth, if needed",
    });
  });

  it("refuses a line that carries a price of its own: every line's money comes from the list", async () => {
    const priced = [
      { code: "DEN-SP", quantityLow: 1, quantityHigh: 1, unitPricePence: 1 },
    ] as unknown as EstimateLineInput[];

    const refused = await refusal(
      makeEstimateVersion(db, { practiceId, caseId, actor: "vet", lines: priced }),
    );

    expect(refused.reason).toBe("lines_refused");
    expect(refused.issues).toEqual([
      { line: 1, code: "DEN-SP", message: "a line carries no price of its own: unitPricePence" },
    ]);
  });

  it("refuses a code that is not on the practice's list, naming it", async () => {
    const refused = await refusal(
      makeEstimateVersion(db, {
        practiceId,
        caseId,
        actor: "vet",
        lines: [
          { code: "DEN-SP", quantityLow: 1, quantityHigh: 1 },
          { code: "DEN-ROOT", quantityLow: 1, quantityHigh: 1 },
        ],
      }),
    );

    expect(refused.issues).toEqual([
      { line: 2, code: "DEN-ROOT", message: "DEN-ROOT is not on the practice's price list" },
    ]);
  });

  it("refuses a quantity range that runs backwards", async () => {
    const refused = await refusal(
      makeEstimateVersion(db, {
        practiceId,
        caseId,
        actor: "vet",
        lines: [{ code: "DEN-EXT", quantityLow: 3, quantityHigh: 1 }],
      }),
    );

    expect(refused.issues).toEqual([
      { line: 1, code: "DEN-EXT", message: "the low quantity is above the high one" },
    ]);
  });

  it("keeps an empty draft, for a vet to fill by hand, but will not send it", async () => {
    const draft = await makeEstimateVersion(db, { practiceId, caseId, actor: "vet", lines: [] });

    expect(draft.totals).toEqual({ lowPence: 0, highPence: 0 });
    expect(
      (await refusal(sendEstimateVersion(db, { practiceId, versionId: draft.id, actor: "vet" })))
        .reason,
    ).toBe("empty");
  });

  it("changes a draft's lines in place and records it", async () => {
    const draft = await makeEstimateVersion(db, { practiceId, caseId, actor: "vet", lines: [] });

    const changed = await replaceDraftLines(db, {
      practiceId,
      versionId: draft.id,
      actor: "vet",
      lines: DENTAL.slice(0, 2),
    });

    expect(changed.number).toBe(1);
    expect(changed.totals).toEqual({ lowPence: 50_500, highPence: 50_500 });
    const actions = await db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(eq(auditEvent.caseId, caseId))
      .orderBy(asc(auditEvent.id));
    expect(actions.map((row) => row.action)).toEqual([
      "estimate.version_made",
      "estimate.draft_changed",
    ]);
  });

  it("cannot change once sent: a change is made as a new version", async () => {
    const first = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: DENTAL,
    });
    await sendEstimateVersion(db, { practiceId, versionId: first.id, actor: "vet" });

    const changeSent = await refusal(
      replaceDraftLines(db, { practiceId, versionId: first.id, actor: "vet", lines: [] }),
    );
    const sendAgain = await refusal(
      sendEstimateVersion(db, { practiceId, versionId: first.id, actor: "vet" }),
    );
    const second = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [...linesOf(first), { code: "CON-STD", quantityLow: 1, quantityHigh: 1 }],
    });

    expect(changeSent.reason).toBe("sent");
    expect(sendAgain.reason).toBe("sent");
    expect(second.number).toBe(2);
    expect(second.totals).toEqual({ lowPence: 62_500, highPence: 82_100 });
    const kept = await loadEstimateVersion(db, practiceId, first.id);
    expect(kept?.totals).toEqual(first.totals);
    expect(kept?.lines).toEqual(first.lines);
  });

  it("writes estimate.sent with the top of the range as the amount, and the range", async () => {
    const draft = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: DENTAL,
    });

    const sent = await sendEstimateVersion(db, { practiceId, versionId: draft.id, actor: "vet" });

    expect(sent.sentAt).toBeInstanceOf(Date);
    const [event] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.sent")));
    expect(event).toMatchObject({ actor: "vet", amountPence: 77_300, currencyCode: "GBP" });
    expect(event!.detail).toEqual({
      versionId: draft.id,
      number: 1,
      lowPence: 57_700,
      highPence: 77_300,
    });
    const [made] = await db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.action, "estimate.version_made")));
    expect(made!.detail).toMatchObject({ versionId: draft.id, number: 1, lineCount: 4 });
  });

  it("keeps a sent version's prices when the list is re-imported, and prices the next from the new list", async () => {
    const first = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [{ code: "CON-STD", quantityLow: 1, quantityHigh: 1 }],
    });
    await sendEstimateVersion(db, { practiceId, versionId: first.id, actor: "vet" });
    await importPriceList(db, {
      practiceId,
      actor: "vet",
      sourceName: "prices-2027.csv",
      csv: PRICES.replace("consultation,4800", "consultation,5200"),
    });

    const second = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: linesOf(first),
    });

    expect((await loadEstimateVersion(db, practiceId, first.id))?.totals.highPence).toBe(4_800);
    expect(second.totals.highPence).toBe(5_200);
  });

  it("allows one draft at a time", async () => {
    await makeEstimateVersion(db, { practiceId, caseId, actor: "vet", lines: [] });

    expect(
      (await refusal(makeEstimateVersion(db, { practiceId, caseId, actor: "vet", lines: [] })))
        .reason,
    ).toBe("draft_exists");
  });

  it("refuses a case from another practice", async () => {
    const [other] = await db
      .insert(practice)
      .values({ name: "Other practice", kind: "judge" })
      .returning();
    await importPriceList(db, {
      practiceId: other!.id,
      actor: "system",
      sourceName: "prices.csv",
      csv: PRICES,
    });

    const refused = await refusal(
      makeEstimateVersion(db, { practiceId: other!.id, caseId, actor: "vet", lines: [] }),
    );

    expect(refused.reason).toBe("case_not_found");
  });

  it("refuses a practice with no price list", async () => {
    const [bare] = await db.insert(practice).values({ name: "Bare", kind: "judge" }).returning();
    const [kase] = await db
      .insert(patientCase)
      .values({ practiceId: bare!.id, patientName: "Tess", ownerName: "B. Owner", procedure: "X" })
      .returning();

    const refused = await refusal(
      makeEstimateVersion(db, { practiceId: bare!.id, caseId: kase!.id, actor: "vet", lines: [] }),
    );

    expect(refused.reason).toBe("no_price_list");
  });
});

describe("the delta between versions (plan 3.3)", () => {
  it("names each item added, removed or changed, and the change in the totals", async () => {
    const first = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [
        { code: "GA-DENT", quantityLow: 1, quantityHigh: 1 },
        { code: "DEN-SP", quantityLow: 1, quantityHigh: 1 },
        { code: "DEN-EXT", quantityLow: 0, quantityHigh: 2 },
        { code: "LAB-PRE", quantityLow: 1, quantityHigh: 1 },
      ],
    });
    await sendEstimateVersion(db, { practiceId, versionId: first.id, actor: "vet" });
    const second = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [
        { code: "GA-DENT", quantityLow: 1, quantityHigh: 1 },
        { code: "DEN-SP", quantityLow: 1, quantityHigh: 1 },
        { code: "DEN-EXT", quantityLow: 4, quantityHigh: 5 },
        { code: "CON-STD", quantityLow: 1, quantityHigh: 1 },
      ],
    });

    const delta = estimateDelta(first, second);

    expect(delta.from).toEqual({ versionId: first.id, number: 1 });
    expect(delta.to).toEqual({ versionId: second.id, number: 2 });
    expect(delta.items).toEqual([
      {
        code: "DEN-EXT",
        name: "Tooth extraction",
        change: "changed",
        before: { quantityLow: 0, quantityHigh: 2, lowPence: 0, highPence: 19_600 },
        after: { quantityLow: 4, quantityHigh: 5, lowPence: 39_200, highPence: 49_000 },
        lowPence: 39_200,
        highPence: 29_400,
      },
      {
        code: "CON-STD",
        name: "Consultation",
        change: "added",
        before: null,
        after: { quantityLow: 1, quantityHigh: 1, lowPence: 4_800, highPence: 4_800 },
        lowPence: 4_800,
        highPence: 4_800,
      },
      {
        code: "LAB-PRE",
        name: "Pre-anaesthetic blood screen",
        change: "removed",
        before: { quantityLow: 1, quantityHigh: 1, lowPence: 7_200, highPence: 7_200 },
        after: null,
        lowPence: -7_200,
        highPence: -7_200,
      },
    ]);
    expect(delta.totals).toEqual({ lowPence: 36_800, highPence: 27_000 });
    expect(second.totals.highPence - first.totals.highPence).toBe(delta.totals.highPence);
  });

  it("refuses to compare versions of different cases", async () => {
    const first = await makeEstimateVersion(db, { practiceId, caseId, actor: "vet", lines: [] });
    const [otherCase] = await db
      .insert(patientCase)
      .values({ practiceId, patientName: "Tess", ownerName: "B. Owner", procedure: "Spay" })
      .returning();
    const other = await makeEstimateVersion(db, {
      practiceId,
      caseId: otherCase!.id,
      actor: "vet",
      lines: [],
    });

    expect(() => estimateDelta(first, other)).toThrow(EstimateError);
  });
});

describe("an estimate version, kept to its practice and its prices", () => {
  it("is not reached through another practice", async () => {
    const draft = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: DENTAL,
    });
    const [other] = await db
      .insert(practice)
      .values({ name: "Other practice", kind: "judge" })
      .returning();
    const otherId = other!.id;

    const send = await refusal(
      sendEstimateVersion(db, { practiceId: otherId, versionId: draft.id, actor: "vet" }),
    );
    const replace = await refusal(
      replaceDraftLines(db, { practiceId: otherId, versionId: draft.id, actor: "vet", lines: [] }),
    );
    const trigger = await refusal(
      checkEstimateTrigger(db, { practiceId: otherId, versionId: draft.id }),
    );

    expect([send.reason, replace.reason, trigger.reason]).toEqual([
      "version_not_found",
      "version_not_found",
      "version_not_found",
    ]);
    expect(await loadEstimateVersion(db, otherId, draft.id)).toBeNull();
    expect(await caseEstimateVersions(db, otherId, caseId)).toEqual([]);
    expect((await loadEstimateVersion(db, practiceId, draft.id))?.lines).toHaveLength(4);
  });

  it("refuses a case in another currency than the list's", async () => {
    const [dollars] = await db
      .insert(patientCase)
      .values({
        practiceId,
        patientName: "Rex",
        ownerName: "D. Owner",
        procedure: "Spay",
        currencyCode: "USD",
      })
      .returning();

    const refused = await refusal(
      makeEstimateVersion(db, { practiceId, caseId: dollars!.id, actor: "vet", lines: [] }),
    );

    expect(refused.reason).toBe("currency_mismatch");
  });

  it("refuses a total past the largest amount stored", async () => {
    await importPriceList(db, {
      practiceId,
      actor: "vet",
      sourceName: "dear.csv",
      csv: [
        "code,name,category,unit,unit_price_pence",
        "DEAR-1,Dear item,procedure,item,2000000",
        "DEAR-2,Dearer item,procedure,item,2000000",
      ].join("\n"),
    });

    const refused = await refusal(
      makeEstimateVersion(db, {
        practiceId,
        caseId,
        actor: "vet",
        lines: [
          { code: "DEAR-1", quantityLow: 1, quantityHigh: 1_000 },
          { code: "DEAR-2", quantityLow: 1, quantityHigh: 1_000 },
        ],
      }),
    );

    expect(refused.reason).toBe("too_large");
  });

  it("refuses a malformed request with a typed refusal", async () => {
    const refused = await refusal(
      makeEstimateVersion(db, { practiceId: "not-a-uuid", caseId, actor: "vet", lines: [] }),
    );

    expect(refused.reason).toBe("request_invalid");
  });

  it("will not send a draft at the prices of a list since replaced, and reprices it from the current one", async () => {
    const draft = await makeEstimateVersion(db, {
      practiceId,
      caseId,
      actor: "vet",
      lines: [{ code: "CON-STD", quantityLow: 1, quantityHigh: 1 }],
    });
    await importPriceList(db, {
      practiceId,
      actor: "vet",
      sourceName: "prices-2027.csv",
      csv: PRICES.replace("consultation,4800", "consultation,5200"),
    });

    const stale = await refusal(
      sendEstimateVersion(db, { practiceId, versionId: draft.id, actor: "vet" }),
    );
    const repriced = await replaceDraftLines(db, {
      practiceId,
      versionId: draft.id,
      actor: "vet",
      lines: linesOf(draft),
    });
    const sent = await sendEstimateVersion(db, { practiceId, versionId: draft.id, actor: "vet" });

    expect(stale.reason).toBe("price_list_changed");
    expect(repriced.totals.highPence).toBe(5_200);
    expect(sent.totals.highPence).toBe(5_200);
  });
});
