import { createDatabase, type Database } from "@/db/client";
import { patientCase, practice } from "@/db/schema";
import { type EstimateLineInput, makeEstimateVersion } from "@/estimate/version";
import { sendEstimate } from "@/money/holds";
import { ownerLink } from "@/owner/link";

import { seedFictionalPractice } from "../../../../seed/practice";
import { browserDatabaseUrl } from "../../database";

/*
 * The cases the owner's walks open, written into the run's database through
 * U2's and U3's own functions, the practice seeded as a judge's practice is
 * (D2's fictional practice and its price list).
 */

/** The vet's notes for Bramble's dental, which the lines quote. */
export const BRAMBLE_NOTES =
  "Bramble, 9yo spaniel. Heavy tartar, gingivitis. GA, pre-op bloods, dental charting, scale and polish, dental rads. Probable 2 surgical extractions upper PM4s. Meloxicam to go home.";

/** Bramble's estimate: £731.00 to £927.00, the hold £927.00 (D3). */
export const BRAMBLE_LINES: EstimateLineInput[] = [
  {
    code: "LAB-PRE",
    quantityLow: 1,
    quantityHigh: 1,
    notesSpan: "pre-op bloods",
    ownerWording: "A blood test before the anaesthetic, to check it is safe",
  },
  {
    code: "GA-DENT",
    quantityLow: 1,
    quantityHigh: 1,
    notesSpan: "GA",
    ownerWording: "General anaesthetic for the dental work",
  },
  {
    code: "DEN-CHART",
    quantityLow: 1,
    quantityHigh: 1,
    notesSpan: "dental charting",
    ownerWording: "Checking and recording each tooth",
  },
  {
    code: "DEN-SP",
    quantityLow: 1,
    quantityHigh: 1,
    notesSpan: "scale and polish",
    ownerWording: "Cleaning and polishing the teeth",
  },
  {
    code: "IMG-XR-DENT",
    quantityLow: 1,
    quantityHigh: 1,
    notesSpan: "dental rads",
    ownerWording: "X-rays of the teeth and their roots",
  },
  {
    code: "DEN-EXT-SG",
    quantityLow: 0,
    quantityHigh: 2,
    dependsOn: "the X-rays show the upper back teeth need to come out",
    notesSpan: "Probable 2 surgical extractions upper PM4s",
    ownerWording: "Removing up to two damaged back teeth",
  },
  {
    code: "MED-NSAID-ORAL",
    quantityLow: 1,
    quantityHigh: 1,
    notesSpan: "Meloxicam to go home",
    ownerWording: "Pain relief medicine to take home",
  },
];

/** A case the walks open, and its owner's link. */
export interface SentCase {
  readonly practiceId: string;
  readonly caseId: string;
  readonly versionId: string;
  /** The owner's link's path, `/e/{token}`. */
  readonly path: string;
  readonly token: string;
}

/**
 * Opens the run's database for one test file.
 *
 * @returns The database.
 */
export function openBrowserDatabase(): Database {
  return createDatabase(browserDatabaseUrl(), { max: 2 });
}

/**
 * The server's secret for this run, which the owner's links are signed with.
 *
 * @returns The secret.
 * @throws Error when the run has none.
 */
export function browserSecret(): string {
  const secret = process.env.PAWHOLD_BROWSER_SECRET;
  if (!secret) {
    throw new Error("the browser suite's secret is set by playwright.config.ts");
  }
  return secret;
}

/**
 * A practice seeded as a judge's is, with Bramble's case and no estimate yet.
 *
 * @param db - The run's database.
 * @returns The practice and the case.
 */
export async function brambleCase(
  db: Database["db"],
): Promise<{ practiceId: string; caseId: string }> {
  return db.transaction(async (tx) => {
    const [made] = await tx
      .insert(practice)
      .values({ name: "pawhold demo practice", kind: "judge" })
      .returning();
    await seedFictionalPractice(tx, made!.id);
    const [kase] = await tx
      .insert(patientCase)
      .values({
        practiceId: made!.id,
        patientName: "Bramble",
        ownerName: "Sam Carter",
        procedure: "Dental under anaesthetic",
      })
      .returning();
    return { practiceId: made!.id, caseId: kase!.id };
  });
}

/**
 * Bramble's case with its estimate sent to the owner, and the owner's link
 * minted at `now`.
 *
 * @param db - The run's database.
 * @param now - When the link is minted; the default is now.
 * @returns The case and its link.
 */
export async function sentBrambleEstimate(
  db: Database["db"],
  now: Date = new Date(),
): Promise<SentCase> {
  const fixture = await brambleCase(db);
  const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: BRAMBLE_LINES });
  await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
  const link = await ownerLink(
    db,
    { ...fixture, versionId: draft.id },
    { secret: browserSecret(), now },
  );
  return { ...fixture, versionId: draft.id, path: link.path, token: link.token };
}
