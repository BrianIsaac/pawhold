import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  estimateLine,
  estimateVersion,
  patientCase,
  practice,
  priceList,
  priceListItem,
} from "@/db/schema";

import { connectTestDatabase } from "../support/database";
import { refusalOf } from "../support/postgres-error";

const { db } = connectTestDatabase();

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const RESTRICT_VIOLATION = "23001";

let practiceId: string;
let listId: string;
let scaleId: string;
let extractionId: string;

beforeAll(async () => {
  const [made] = await db
    .insert(practice)
    .values({ name: "Schema practice", kind: "judge" })
    .returning();
  practiceId = made!.id;
  const [list] = await db
    .insert(priceList)
    .values({ practiceId, currencyCode: "GBP", sourceName: "schema-test.csv" })
    .returning();
  listId = list!.id;
  const items = await db
    .insert(priceListItem)
    .values([
      {
        priceListId: listId,
        code: "DEN-SP",
        name: "Dental scale and polish",
        category: "procedure",
        unit: "procedure",
        unitPricePence: 18_500,
      },
      {
        priceListId: listId,
        code: "DEN-EXT",
        name: "Tooth extraction, surgical",
        category: "procedure",
        unit: "tooth",
        unitPricePence: 9_800,
      },
    ])
    .returning();
  scaleId = items[0]!.id;
  extractionId = items[1]!.id;
});

/**
 * Opens a case of its own for a test.
 *
 * @returns The case's id.
 */
async function newCase(): Promise<string> {
  const [kase] = await db
    .insert(patientCase)
    .values({ practiceId, patientName: "Biscuit", ownerName: "A. Owner", procedure: "Dental" })
    .returning();
  return kase!.id;
}

/**
 * Makes a draft version.
 *
 * @param forCase - The case; a new one when not given.
 * @param number - The version's number.
 * @returns The version's id.
 */
async function draftVersion(forCase?: string, number = 1): Promise<string> {
  const [version] = await db
    .insert(estimateVersion)
    .values({ practiceId, caseId: forCase ?? (await newCase()), priceListId: listId, number })
    .returning();
  return version!.id;
}

describe("the estimate schema as migrated (plan 3.3)", () => {
  it("holds the price list, version and line tables", async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name
    `);

    expect(rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "estimate_line",
        "estimate_version",
        "price_list",
        "price_list_item",
      ]),
    );
  });

  it("works a line's money out from the list's price, in pence, at the database", async () => {
    const versionId = await draftVersion();
    const [line] = await db
      .insert(estimateLine)
      .values({
        versionId,
        priceListId: listId,
        position: 1,
        priceListItemId: extractionId,
        unitPricePence: 9_800,
        quantityLow: 0,
        quantityHigh: 2,
        dependsOn: "only if extractions are needed",
      })
      .returning();

    expect(line!.lowPence).toBe(0);
    expect(line!.highPence).toBe(19_600);
  });

  it("refuses a line whose unit price is not the list's", async () => {
    const versionId = await draftVersion();

    const { code } = await refusalOf(
      db.insert(estimateLine).values({
        versionId,
        priceListId: listId,
        position: 1,
        priceListItemId: scaleId,
        unitPricePence: 1,
        quantityLow: 1,
        quantityHigh: 1,
      }),
    );

    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("refuses a quantity range that runs backwards", async () => {
    const versionId = await draftVersion();

    const { code } = await refusalOf(
      db.insert(estimateLine).values({
        versionId,
        priceListId: listId,
        position: 1,
        priceListItemId: scaleId,
        unitPricePence: 18_500,
        quantityLow: 2,
        quantityHigh: 1,
      }),
    );

    expect(code).toBe(CHECK_VIOLATION);
  });

  it("numbers a case's versions once each and allows one draft at a time", async () => {
    const kase = await newCase();
    const first = await draftVersion(kase, 1);

    const secondDraft = await refusalOf(
      db
        .insert(estimateVersion)
        .values({ practiceId, caseId: kase, priceListId: listId, number: 2 }),
    );
    await db.insert(estimateLine).values({
      versionId: first,
      priceListId: listId,
      position: 1,
      priceListItemId: scaleId,
      unitPricePence: 18_500,
      quantityLow: 1,
      quantityHigh: 1,
    });
    await db
      .update(estimateVersion)
      .set({ sentAt: new Date(), totalLowPence: 18_500, totalHighPence: 18_500 })
      .where(eq(estimateVersion.id, first));
    const sameNumber = await refusalOf(
      db
        .insert(estimateVersion)
        .values({ practiceId, caseId: kase, priceListId: listId, number: 1 }),
    );

    expect(secondDraft.code).toBe(UNIQUE_VIOLATION);
    expect(sameNumber.code).toBe(UNIQUE_VIOLATION);
  });

  it("keeps a version's case and price list inside one practice", async () => {
    const [other] = await db
      .insert(practice)
      .values({ name: "Another practice", kind: "judge" })
      .returning();

    const { code } = await refusalOf(
      db
        .insert(estimateVersion)
        .values({ practiceId: other!.id, caseId: await newCase(), priceListId: listId, number: 1 }),
    );

    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("keeps a price list's items as imported", async () => {
    const update = await refusalOf(
      db.update(priceListItem).set({ unitPricePence: 1 }).where(eq(priceListItem.id, scaleId)),
    );
    const remove = await refusalOf(db.delete(priceListItem).where(eq(priceListItem.id, scaleId)));

    expect(update.code).toBe(RESTRICT_VIOLATION);
    expect(remove.code).toBe(RESTRICT_VIOLATION);
  });

  describe("a sent version", () => {
    let versionId: string;
    let lineId: string;

    beforeAll(async () => {
      versionId = await draftVersion();
      const [line] = await db
        .insert(estimateLine)
        .values({
          versionId,
          priceListId: listId,
          position: 1,
          priceListItemId: scaleId,
          unitPricePence: 18_500,
          quantityLow: 1,
          quantityHigh: 1,
        })
        .returning();
      lineId = line!.id;
    });

    it("cannot be sent without a line", async () => {
      const empty = await draftVersion();

      const { code } = await refusalOf(
        db
          .update(estimateVersion)
          .set({ sentAt: new Date(), totalLowPence: 0, totalHighPence: 0 })
          .where(eq(estimateVersion.id, empty)),
      );

      expect(code).toBe(CHECK_VIOLATION);
    });

    it("cannot be sent with totals that are not its lines'", async () => {
      const { code } = await refusalOf(
        db
          .update(estimateVersion)
          .set({ sentAt: new Date(), totalLowPence: 1, totalHighPence: 1 })
          .where(eq(estimateVersion.id, versionId)),
      );

      expect(code).toBe(CHECK_VIOLATION);
    });

    it("cannot change once sent, nor can its lines", async () => {
      await db
        .update(estimateVersion)
        .set({ sentAt: new Date(), totalLowPence: 18_500, totalHighPence: 18_500 })
        .where(eq(estimateVersion.id, versionId));

      const version = await refusalOf(
        db
          .update(estimateVersion)
          .set({ totalHighPence: 99_999 })
          .where(eq(estimateVersion.id, versionId)),
      );
      const remove = await refusalOf(
        db.delete(estimateVersion).where(eq(estimateVersion.id, versionId)),
      );
      const lineChange = await refusalOf(
        db.update(estimateLine).set({ quantityHigh: 3 }).where(eq(estimateLine.id, lineId)),
      );
      const lineRemove = await refusalOf(
        db.delete(estimateLine).where(eq(estimateLine.id, lineId)),
      );
      const lineAdd = await refusalOf(
        db.insert(estimateLine).values({
          versionId,
          priceListId: listId,
          position: 2,
          priceListItemId: extractionId,
          unitPricePence: 9_800,
          quantityLow: 1,
          quantityHigh: 1,
        }),
      );

      for (const refusal of [version, remove, lineChange, lineRemove, lineAdd]) {
        expect(refusal.code).toBe(RESTRICT_VIOLATION);
      }
    });
  });
});
