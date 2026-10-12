import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Executor } from "@/db/client";
import { auditActor, practice, priceCategory, priceList, priceListItem } from "@/db/schema";
import { type CurrencyCode, currencyCode } from "@/money/currency";

import { CsvSyntaxError, readCsv } from "./csv";
import { EstimateError } from "./errors";

/** The columns a price list's CSV carries, in any order. */
export const PRICE_LIST_COLUMNS = ["code", "name", "category", "unit", "unit_price_pence"] as const;

type PriceListColumn = (typeof PRICE_LIST_COLUMNS)[number];

/**
 * The largest unit price an item may carry: £20,000.00. With a line's
 * quantity capped (`MAX_LINE_QUANTITY`), a line's money stays inside a
 * Postgres `integer`.
 */
export const MAX_UNIT_PRICE_PENCE = 2_000_000;

/** The most items one price list holds. */
export const MAX_PRICE_LIST_ITEMS = 2_000;

/** The largest price list file read: 512 KiB. */
export const MAX_PRICE_LIST_BYTES = 512 * 1024;

/** A price list code: upper-case letters and digits in hyphenated groups, as `DEN-EXT-2`. */
export const priceListCode = z
  .string()
  .max(32, "a code is at most 32 characters")
  .regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, "a code is upper-case letters and digits, joined by hyphens");

export type PriceCategory = (typeof priceCategory.enumValues)[number];

const WHOLE_PENCE = /^\d+$/;
const NEGATIVE_WHOLE = /^-\d+(\.\d+)?$/;

const itemFields = {
  code: priceListCode,
  name: z.string().min(1, "a name is required").max(200, "a name is at most 200 characters"),
  category: z.enum(priceCategory.enumValues, {
    error: (issue) =>
      `the category is one of ${priceCategory.enumValues.join(", ")}: ${String(issue.input)} is not`,
  }),
  unit: z.string().min(1, "a unit is required").max(40, "a unit is at most 40 characters"),
  unit_price_pence: z
    .string()
    .superRefine((value, context) => {
      if (NEGATIVE_WHOLE.test(value)) {
        context.addIssue({ code: "custom", message: `a price cannot be negative: ${value}` });
      } else if (value === "") {
        context.addIssue({ code: "custom", message: "a price is required" });
      } else if (!WHOLE_PENCE.test(value)) {
        context.addIssue({
          code: "custom",
          message: `a price is a whole number of pence: ${value} is not`,
        });
      } else if (Number(value) > MAX_UNIT_PRICE_PENCE) {
        context.addIssue({
          code: "custom",
          message: `a unit price is at most ${MAX_UNIT_PRICE_PENCE} pence`,
        });
      }
    })
    .transform(Number),
} satisfies Record<PriceListColumn, z.ZodType>;

/** One item read from a price list, with the row it came from. */
export interface PriceListEntry {
  readonly row: number;
  readonly code: string;
  readonly name: string;
  readonly category: PriceCategory;
  readonly unit: string;
  /** The unit price in pence, including VAT (plan 3.3). */
  readonly unitPricePence: number;
}

/** Why a price list was refused: the row and column, where there is one. */
export interface PriceListIssue {
  readonly row: number | null;
  readonly column: string | null;
  readonly message: string;
}

/** A price list refused, with every reason found. */
export class PriceListImportError extends Error {
  override readonly name = "PriceListImportError";

  /**
   * @param issues - Each fault, by row and column.
   */
  constructor(readonly issues: readonly PriceListIssue[]) {
    super(`price list refused: ${issues.map(describeIssue).join("; ")}`);
  }
}

/**
 * One issue in words, as `row 3, unit_price_pence: a price cannot be negative: -1`.
 *
 * @param issue - The issue.
 * @returns The sentence.
 */
function describeIssue(issue: PriceListIssue): string {
  const where = [issue.row === null ? null : `row ${issue.row}`, issue.column]
    .filter((part) => part !== null)
    .join(", ");
  return where === "" ? issue.message : `${where}: ${issue.message}`;
}

/**
 * Reads and validates a price list from CSV with the columns
 * {@link PRICE_LIST_COLUMNS}: a code, a name, a category of plan 3.3's eight, a
 * unit, and the unit price in whole pence including VAT. Every row is checked
 * and every fault reported with its row (the header is row 1), so a practice
 * can fix its file in one pass.
 *
 * @param text - The CSV text.
 * @returns The items, in the file's order.
 * @throws PriceListImportError when the file or any row is refused.
 */
export function parsePriceList(text: string): PriceListEntry[] {
  if (Buffer.byteLength(text, "utf8") > MAX_PRICE_LIST_BYTES) {
    throw new PriceListImportError([
      { row: null, column: null, message: `the file is over ${MAX_PRICE_LIST_BYTES} bytes` },
    ]);
  }
  let records;
  try {
    records = readCsv(text);
  } catch (error) {
    if (error instanceof CsvSyntaxError) {
      throw new PriceListImportError([{ row: error.row, column: null, message: error.reason }]);
    }
    throw error;
  }

  const [header, ...rows] = records;
  if (!header) {
    throw new PriceListImportError([{ row: null, column: null, message: "the file is empty" }]);
  }
  const columns = readHeader(header.row, header.fields);

  const issues: PriceListIssue[] = [];
  const entries: PriceListEntry[] = [];
  const firstRowOfCode = new Map<string, number>();
  for (const { row, fields } of rows) {
    if (fields.length !== columns.length) {
      issues.push({
        row,
        column: null,
        message: `${columns.length} fields expected, ${fields.length} found`,
      });
      continue;
    }
    const values = Object.fromEntries(
      columns.map((column, at) => [column, fields[at]!.trim()]),
    ) as Record<PriceListColumn, string>;

    const parsed: Partial<Record<PriceListColumn, unknown>> = {};
    for (const column of PRICE_LIST_COLUMNS) {
      const result = itemFields[column].safeParse(values[column]);
      if (result.success) {
        parsed[column] = result.data;
      } else {
        issues.push({ row, column, message: result.error.issues[0]!.message });
      }
    }
    const code = values.code;
    if (parsed.code !== undefined) {
      const seen = firstRowOfCode.get(code);
      if (seen !== undefined) {
        issues.push({ row, column: "code", message: `code ${code} is already on row ${seen}` });
        continue;
      }
      firstRowOfCode.set(code, row);
    }
    if (Object.keys(parsed).length === PRICE_LIST_COLUMNS.length) {
      entries.push({
        row,
        code: parsed.code as string,
        name: parsed.name as string,
        category: parsed.category as PriceCategory,
        unit: parsed.unit as string,
        unitPricePence: parsed.unit_price_pence as number,
      });
    }
  }

  if (issues.length === 0 && entries.length === 0) {
    issues.push({ row: null, column: null, message: "the price list has no items" });
  }
  if (rows.length > MAX_PRICE_LIST_ITEMS) {
    issues.push({
      row: null,
      column: null,
      message: `a price list holds at most ${MAX_PRICE_LIST_ITEMS} items`,
    });
  }
  if (issues.length > 0) {
    throw new PriceListImportError(sortIssues(issues));
  }
  return entries;
}

/**
 * Checks the header row names each column once and nothing else.
 *
 * @param row - The header's row.
 * @param fields - The header's fields.
 * @returns The columns, in the file's order.
 * @throws PriceListImportError when a column is unknown, repeated or missing.
 */
function readHeader(row: number, fields: readonly string[]): PriceListColumn[] {
  const names = fields.map((field) => field.trim().toLowerCase());
  const issues: PriceListIssue[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!(PRICE_LIST_COLUMNS as readonly string[]).includes(name)) {
      issues.push({ row, column: name, message: `unknown column: ${name}` });
    } else if (seen.has(name)) {
      issues.push({ row, column: name, message: `column ${name} appears twice` });
    }
    seen.add(name);
  }
  for (const column of PRICE_LIST_COLUMNS) {
    if (!seen.has(column)) {
      issues.push({ row, column, message: `missing column: ${column}` });
    }
  }
  if (issues.length > 0) {
    throw new PriceListImportError(issues);
  }
  return names as PriceListColumn[];
}

/**
 * Orders issues by row, then by the column's place in {@link PRICE_LIST_COLUMNS}.
 *
 * @param issues - The issues.
 * @returns The issues, sorted.
 */
function sortIssues(issues: readonly PriceListIssue[]): PriceListIssue[] {
  const place = (column: string | null) =>
    column === null ? -1 : (PRICE_LIST_COLUMNS as readonly string[]).indexOf(column);
  return [...issues].sort(
    (a, b) =>
      (a.row ?? Number.MAX_SAFE_INTEGER) - (b.row ?? Number.MAX_SAFE_INTEGER) ||
      place(a.column) - place(b.column),
  );
}

const importRequest = z.strictObject({
  practiceId: z.uuid(),
  actor: z.enum(auditActor.enumValues),
  sourceName: z.string().trim().min(1).max(255),
  currency: currencyCode.default("GBP"),
  csv: z.string(),
});

export type PriceListImportRequest = z.input<typeof importRequest>;

/** A price list as stored. */
export interface ImportedPriceList {
  readonly id: string;
  readonly practiceId: string;
  readonly currencyCode: CurrencyCode;
  readonly sourceName: string;
  readonly importedAt: Date;
  readonly itemCount: number;
}

/**
 * Imports a practice's price list from CSV: validates every row, stores the
 * list and its items, and writes `pricelist.imported` to the audit trail, all
 * in one transaction (a savepoint when given one). A refused list writes
 * nothing. The new list becomes the practice's current one; earlier lists are
 * kept, since versions priced from them point at them.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, who imported it, the file's name, its currency and its text.
 * @returns The stored list.
 * @throws PriceListImportError when the file or any row is refused.
 * @throws EstimateError when the request is malformed or there is no such practice.
 */
export async function importPriceList(
  executor: Executor,
  request: PriceListImportRequest,
): Promise<ImportedPriceList> {
  const parsed = importRequest.safeParse(request);
  if (!parsed.success) {
    throw new EstimateError(
      "request_invalid",
      `price list import refused: ${z.prettifyError(parsed.error)}`,
    );
  }
  const { practiceId, actor, sourceName, currency, csv } = parsed.data;
  const entries = parsePriceList(csv);

  return executor.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: practice.id })
      .from(practice)
      .where(eq(practice.id, practiceId));
    if (!owner) {
      throw new EstimateError("request_invalid", `there is no practice ${practiceId}`);
    }
    const [list] = await tx
      .insert(priceList)
      .values({ practiceId, currencyCode: currency, sourceName, itemCount: entries.length })
      .returning();
    await tx.insert(priceListItem).values(
      entries.map((entry) => ({
        priceListId: list!.id,
        code: entry.code,
        name: entry.name,
        category: entry.category,
        unit: entry.unit,
        unitPricePence: entry.unitPricePence,
      })),
    );
    await appendAuditEvent(tx, {
      practiceId,
      actor,
      action: "pricelist.imported",
      detail: { priceListId: list!.id, sourceName, itemCount: entries.length, currency },
    });
    return {
      id: list!.id,
      practiceId,
      currencyCode: currency,
      sourceName,
      importedAt: list!.importedAt,
      itemCount: entries.length,
    };
  });
}

/** A price list item as stored. */
export interface PricedItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly category: PriceCategory;
  readonly unit: string;
  readonly unitPricePence: number;
}

/** A stored price list with its items by code. */
export interface PriceListWithItems {
  readonly id: string;
  readonly practiceId: string;
  readonly currencyCode: CurrencyCode;
  readonly importedAt: Date;
  readonly items: ReadonlyMap<string, PricedItem>;
}

/**
 * The practice's current price list: the one imported last.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @returns The list with its items, or null when the practice has none.
 */
export async function currentPriceList(
  executor: Executor,
  practiceId: string,
): Promise<PriceListWithItems | null> {
  const [latest] = await executor
    .select({ id: priceList.id })
    .from(priceList)
    .where(eq(priceList.practiceId, practiceId))
    .orderBy(desc(priceList.importedAt))
    .limit(1);
  return latest ? loadPriceList(executor, practiceId, latest.id) : null;
}

/**
 * A practice's price list by id, with its items.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice the list must belong to.
 * @param priceListId - The list.
 * @returns The list with its items, or null when the practice has no such list.
 */
export async function loadPriceList(
  executor: Executor,
  practiceId: string,
  priceListId: string,
): Promise<PriceListWithItems | null> {
  const [list] = await executor
    .select()
    .from(priceList)
    .where(and(eq(priceList.id, priceListId), eq(priceList.practiceId, practiceId)));
  if (!list) {
    return null;
  }
  const items = await executor
    .select({
      id: priceListItem.id,
      code: priceListItem.code,
      name: priceListItem.name,
      category: priceListItem.category,
      unit: priceListItem.unit,
      unitPricePence: priceListItem.unitPricePence,
    })
    .from(priceListItem)
    .where(eq(priceListItem.priceListId, list.id));
  return {
    id: list.id,
    practiceId: list.practiceId,
    currencyCode: currencyCode.parse(list.currencyCode),
    importedAt: list.importedAt,
    items: new Map(items.map((item) => [item.code, item])),
  };
}
