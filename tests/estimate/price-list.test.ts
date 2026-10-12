import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent, practice, priceList, priceListItem } from "@/db/schema";
import {
  currentPriceList,
  importPriceList,
  parsePriceList,
  PriceListImportError,
  type PriceListIssue,
} from "@/estimate/price-list";

import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();

const HEADER = "code,name,category,unit,unit_price_pence";

/**
 * A price list's CSV from its rows, under the header.
 *
 * @param rows - The data rows.
 * @returns The CSV text.
 */
function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n") + "\n";
}

/**
 * The issues a refused price list was refused for.
 *
 * @param text - The CSV text.
 * @returns The issues.
 * @throws Error when the list is not refused.
 */
function issuesOf(text: string): readonly PriceListIssue[] {
  try {
    parsePriceList(text);
  } catch (error) {
    if (error instanceof PriceListImportError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("the price list was not refused");
}

describe("reading a price list (plan 3.3)", () => {
  it("reads each item's code, name, category, unit and price in pence including VAT", () => {
    const items = parsePriceList(
      csv(
        "CON-STD,Consultation,consultation,consultation,4800",
        'DEN-SP,"Dental scale and polish, including charting",procedure,procedure,18500',
      ),
    );

    expect(items).toEqual([
      {
        row: 2,
        code: "CON-STD",
        name: "Consultation",
        category: "consultation",
        unit: "consultation",
        unitPricePence: 4800,
      },
      {
        row: 3,
        code: "DEN-SP",
        name: "Dental scale and polish, including charting",
        category: "procedure",
        unit: "procedure",
        unitPricePence: 18500,
      },
    ]);
  });

  it("takes the columns in any order", () => {
    const [item] = parsePriceList(
      "unit_price_pence,unit,category,name,code\n4800,consultation,consultation,Consultation,CON-STD\n",
    );

    expect(item).toMatchObject({ code: "CON-STD", unitPricePence: 4800 });
  });

  it("refuses a price list row with a negative price, with its row number", () => {
    expect(
      issuesOf(
        csv(
          "CON-STD,Consultation,consultation,consultation,4800",
          "LAB-HAEM,Haematology,laboratory,test,-6500",
        ),
      ),
    ).toEqual([
      { row: 3, column: "unit_price_pence", message: "a price cannot be negative: -6500" },
    ]);
  });

  it("refuses a price list row with a non-integer price, with its row number", () => {
    expect(issuesOf(csv("LAB-HAEM,Haematology,laboratory,test,65.50"))).toEqual([
      {
        row: 2,
        column: "unit_price_pence",
        message: "a price is a whole number of pence: 65.50 is not",
      },
    ]);
  });

  it("names every refused row, not only the first", () => {
    const issues = issuesOf(
      csv(
        "CON-STD,Consultation,consultation,consultation,48.00",
        "CON-STD,Second consultation,consultation,consultation,4800",
        "X-1,Mystery,grooming,item,100",
        "IMG-XR,,imaging,view,",
      ),
    );

    expect(issues.map((issue) => [issue.row, issue.column])).toEqual([
      [2, "unit_price_pence"],
      [3, "code"],
      [4, "category"],
      [5, "name"],
      [5, "unit_price_pence"],
    ]);
    expect(issues[1]!.message).toBe("code CON-STD is already on row 2");
  });

  it("refuses a price that is not a number, and one beyond the largest unit price", () => {
    expect(
      issuesOf(csv("A-1,Item,consumable,item,free", "A-2,Item,consumable,item,2000001")),
    ).toEqual([
      {
        row: 2,
        column: "unit_price_pence",
        message: "a price is a whole number of pence: free is not",
      },
      { row: 3, column: "unit_price_pence", message: "a unit price is at most 2000000 pence" },
    ]);
  });

  it("refuses a header without the columns it needs, or with ones it does not know", () => {
    expect(issuesOf("code,name,category,price\nA-1,Item,consumable,100\n")).toEqual([
      { row: 1, column: "price", message: "unknown column: price" },
      { row: 1, column: "unit", message: "missing column: unit" },
      { row: 1, column: "unit_price_pence", message: "missing column: unit_price_pence" },
    ]);
  });

  it("refuses a row with the wrong number of fields", () => {
    expect(issuesOf(csv("A-1,Item,consumable,item"))).toEqual([
      { row: 2, column: null, message: "5 fields expected, 4 found" },
    ]);
  });

  it("refuses a list with no items", () => {
    expect(issuesOf(csv())).toEqual([
      { row: null, column: null, message: "the price list has no items" },
    ]);
  });

  it("refuses CSV that does not parse, with its row", () => {
    expect(issuesOf(csv('A-1,"Item,consumable,item,100'))).toEqual([
      { row: 2, column: null, message: "a quoted field is never closed" },
    ]);
  });

  it("says each refused row in its message", () => {
    expect(() => parsePriceList(csv("LAB-HAEM,Haematology,laboratory,test,-6500"))).toThrow(
      "price list refused: row 2, unit_price_pence: a price cannot be negative: -6500",
    );
  });
});

describe("importing a price list", () => {
  let practiceId: string;

  beforeEach(async () => {
    const [made] = await db
      .insert(practice)
      .values({ name: "Import practice", kind: "judge" })
      .returning();
    practiceId = made!.id;
  });

  it("stores the list and its items and writes pricelist.imported to the audit trail", async () => {
    const imported = await importPriceList(db, {
      practiceId,
      actor: "vet",
      sourceName: "prices-2026.csv",
      csv: csv(
        "CON-STD,Consultation,consultation,consultation,4800",
        "LAB-HAEM,Haematology,laboratory,test,6500",
      ),
    });

    const items = await db
      .select()
      .from(priceListItem)
      .where(eq(priceListItem.priceListId, imported.id));
    expect(items.map((item) => [item.code, item.unitPricePence])).toEqual(
      expect.arrayContaining([
        ["CON-STD", 4800],
        ["LAB-HAEM", 6500],
      ]),
    );
    expect(imported).toMatchObject({ practiceId, currencyCode: "GBP", itemCount: 2 });

    const [event] = await db
      .select()
      .from(auditEvent)
      .where(
        and(eq(auditEvent.practiceId, practiceId), eq(auditEvent.action, "pricelist.imported")),
      );
    expect(event).toMatchObject({ actor: "vet" });
    expect(event!.detail).toEqual({
      priceListId: imported.id,
      sourceName: "prices-2026.csv",
      itemCount: 2,
      currency: "GBP",
    });
  });

  it("writes nothing when the list is refused", async () => {
    await expect(
      importPriceList(db, {
        practiceId,
        actor: "vet",
        sourceName: "bad.csv",
        csv: csv("LAB-HAEM,Haematology,laboratory,test,-6500"),
      }),
    ).rejects.toBeInstanceOf(PriceListImportError);

    expect(await db.select().from(priceList).where(eq(priceList.practiceId, practiceId))).toEqual(
      [],
    );
    expect(await db.select().from(auditEvent).where(eq(auditEvent.practiceId, practiceId))).toEqual(
      [],
    );
  });

  it("prices from the latest import, keeping the earlier one", async () => {
    const first = await importPriceList(db, {
      practiceId,
      actor: "vet",
      sourceName: "2026.csv",
      csv: csv("CON-STD,Consultation,consultation,consultation,4800"),
    });
    const second = await importPriceList(db, {
      practiceId,
      actor: "vet",
      sourceName: "2027.csv",
      csv: csv("CON-STD,Consultation,consultation,consultation,5200"),
    });

    const current = await currentPriceList(db, practiceId);

    expect(current?.id).toBe(second.id);
    expect(current?.items.get("CON-STD")?.unitPricePence).toBe(5200);
    expect(await db.select().from(priceList).where(eq(priceList.id, first.id))).toHaveLength(1);
  });

  it("has no current list for a practice that never imported one", async () => {
    expect(await currentPriceList(db, practiceId)).toBeNull();
  });
});

describe("an import request", () => {
  it("is refused with a typed refusal when malformed or for no practice", async () => {
    const malformed = importPriceList(db, {
      practiceId: "not-a-uuid",
      actor: "vet",
      sourceName: "p.csv",
      csv: csv("CON-STD,Consultation,consultation,consultation,4800"),
    });
    const nobody = importPriceList(db, {
      practiceId: "00000000-0000-4000-8000-000000000000",
      actor: "vet",
      sourceName: "p.csv",
      csv: csv("CON-STD,Consultation,consultation,consultation,4800"),
    });

    await expect(malformed).rejects.toMatchObject({
      name: "EstimateError",
      reason: "request_invalid",
    });
    await expect(nobody).rejects.toMatchObject({
      name: "EstimateError",
      reason: "request_invalid",
    });
  });
});
