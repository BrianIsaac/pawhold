import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";

import { appendAuditEvent } from "@/audit/writer";
import { practice } from "@/db/schema";
import { importPriceList } from "@/estimate/price-list";
import { DEFAULT_MONETARY_THRESHOLD_PENCE } from "@/estimate/trigger";
import type { PracticeSeed } from "@/judge/session";

import { seedShowcase } from "../showcase";

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
 * same import a practice uses, seeds the showcase (U9: U5's showcase case,
 * U8a's day with its rooms, vets, cases and bookings, and a case at every
 * other money state of plan 3.2), and writes `practice.seeded`, which names
 * the case the owner's door opens.
 *
 * @param tx - The transaction making the practice.
 * @param practiceId - The new practice.
 * @param now - The session's start, which the seeded stories are told back from.
 * @returns Resolves once seeded.
 */
export const seedFictionalPractice: PracticeSeed = async (tx, practiceId, now = new Date()) => {
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
  const showcase = await seedShowcase(tx, practiceId, now);
  await appendAuditEvent(tx, {
    practiceId,
    actor: "system",
    action: "practice.seeded",
    detail: {
      name: FICTIONAL_PRACTICE.name,
      priceListId: list.id,
      itemCount: list.itemCount,
      showcaseCaseId: showcase.showcaseCaseId,
      dayCaseId: showcase.dayCaseId,
      ownerDoorCaseId: showcase.ownerDoorCaseId,
      bookings: showcase.bookings,
    },
  });
};
