import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";

import { appendAuditEvent } from "@/audit/writer";
import { practice } from "@/db/schema";
import { importPriceList } from "@/estimate/price-list";
import { DEFAULT_MONETARY_THRESHOLD_PENCE } from "@/estimate/trigger";
import type { PracticeSeed } from "@/judge/session";

import { seedPracticeDay } from "./day";
import { seedShowcaseCase } from "./showcase";

/**
 * The fictional practice every judge's session is given (D2). Its name is
 * D2's working name; the price list beside this file was written for this
 * entry from the shape of published UK small-animal lists, not copied from
 * any practice's.
 */
export const FICTIONAL_PRACTICE = {
  name: "Hollins Lane Veterinary Surgery",
  monetaryThresholdPence: DEFAULT_MONETARY_THRESHOLD_PENCE,
  priceListSource: "seed/practice/price-list.csv",
} as const;

const PRICE_LIST_URL = new URL("./price-list.csv", import.meta.url);

let priceListText: string | undefined;

/**
 * The seed's price list as CSV, read once.
 *
 * @returns The CSV text.
 */
export function readSeedPriceList(): string {
  priceListText ??= readFileSync(PRICE_LIST_URL, "utf8");
  return priceListText;
}

/**
 * Seeds a new judge practice inside the transaction that makes it: names it,
 * sets the Order's default threshold, imports the price list through the
 * same import a practice uses, opens the showcase case (U5), lays the
 * practice's day (U8a: its rooms, vets, the day's cases and their bookings),
 * and writes `practice.seeded`.
 *
 * @param tx - The transaction making the practice.
 * @param practiceId - The new practice.
 * @returns Resolves once seeded.
 */
export const seedFictionalPractice: PracticeSeed = async (tx, practiceId) => {
  await tx
    .update(practice)
    .set({
      name: FICTIONAL_PRACTICE.name,
      monetaryThresholdPence: FICTIONAL_PRACTICE.monetaryThresholdPence,
    })
    .where(eq(practice.id, practiceId));
  const list = await importPriceList(tx, {
    practiceId,
    actor: "system",
    sourceName: FICTIONAL_PRACTICE.priceListSource,
    csv: readSeedPriceList(),
  });
  const showcaseCaseId = await seedShowcaseCase(tx, practiceId);
  const day = await seedPracticeDay(tx, practiceId, { showcaseCaseId });
  await appendAuditEvent(tx, {
    practiceId,
    actor: "system",
    action: "practice.seeded",
    detail: {
      name: FICTIONAL_PRACTICE.name,
      priceListId: list.id,
      itemCount: list.itemCount,
      showcaseCaseId,
      dayCaseId: day.dayCaseId,
      bookings: day.bookings,
    },
  });
};
