import { patientCase, practice } from "@/db/schema";
import type { Executor } from "@/db/client";
import { importPriceList } from "@/estimate/price-list";
import {
  type EstimateLineInput,
  type EstimateVersionView,
  makeEstimateVersion,
  sendEstimateVersion,
} from "@/estimate/version";

/** A small dental price list, in pence including VAT. */
export const DENTAL_PRICES = [
  "code,name,category,unit,unit_price_pence",
  "CON-STD,Consultation,consultation,consultation,4800",
  "GA-DENT,General anaesthetic for dental work,anaesthesia,procedure,32000",
  "DEN-SP,Dental scale and polish,procedure,procedure,18500",
  "DEN-EXT,Tooth extraction,procedure,tooth,9800",
  "LAB-PRE,Pre-anaesthetic blood screen,laboratory,test,7200",
  "XR-DENT,Dental radiographs,imaging,study,12000",
  "MED-AB,Antibiotic course,medication,course,3500",
].join("\n");

/** The dental estimate of plan 3.3: £577.00 to £773.00. */
export const DENTAL_LINES: EstimateLineInput[] = [
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

/** The update a vet sends after finding more: radiographs and antibiotics. */
export const DENTAL_UPDATE_LINES: EstimateLineInput[] = [
  ...DENTAL_LINES,
  { code: "XR-DENT", quantityLow: 1, quantityHigh: 1, notesSpan: "rads to assess roots" },
  { code: "MED-AB", quantityLow: 1, quantityHigh: 1, notesSpan: "abx to go home" },
];

/** A practice with the dental price list and one case in it. */
export interface MoneyFixture {
  readonly practiceId: string;
  readonly caseId: string;
}

/**
 * Makes a practice with the dental price list and a case with no estimate yet.
 *
 * @param executor - The test database.
 * @param name - The practice's name.
 * @returns The practice and the case.
 */
export async function makeDentalCase(
  executor: Executor,
  name = "Money practice",
): Promise<MoneyFixture> {
  const [made] = await executor.insert(practice).values({ name, kind: "judge" }).returning();
  const practiceId = made!.id;
  await importPriceList(executor, {
    practiceId,
    actor: "system",
    sourceName: "prices.csv",
    csv: DENTAL_PRICES,
  });
  const [kase] = await executor
    .insert(patientCase)
    .values({
      practiceId,
      patientName: "Biscuit",
      species: "dog",
      ownerName: "Ann Owner",
      procedure: "Dental",
    })
    .returning();
  return { practiceId, caseId: kase!.id };
}

/**
 * Makes and sends a version of the case's estimate through U2 alone, leaving
 * the case's money state where it was (for schema tests that need a sent
 * version without the money lifecycle).
 *
 * @param executor - The test database.
 * @param fixture - The practice and the case.
 * @param lines - The version's lines.
 * @returns The version as sent.
 */
export async function sendVersionDirectly(
  executor: Executor,
  fixture: MoneyFixture,
  lines: readonly EstimateLineInput[] = DENTAL_LINES,
): Promise<EstimateVersionView> {
  const draft = await makeEstimateVersion(executor, { ...fixture, actor: "vet", lines });
  return sendEstimateVersion(executor, {
    practiceId: fixture.practiceId,
    versionId: draft.id,
    actor: "vet",
  });
}
