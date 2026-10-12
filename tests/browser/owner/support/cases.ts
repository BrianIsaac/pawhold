import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { appendAuditEvent } from "@/audit/writer";
import { createDatabase, type Database } from "@/db/client";
import { hold, patientCase, practice } from "@/db/schema";
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

/** The vet's finding behind Bramble's update. */
export const BRAMBLE_FINDING =
  "Rads show 4 teeth with root resorption, need surgical extraction. Abx for 7 days.";

/** Bramble's update: up to four extractions and antibiotics; £228.00 over the £927.00 held. */
export const BRAMBLE_UPDATE_LINES: EstimateLineInput[] = [
  ...BRAMBLE_LINES.filter((line) => line.code !== "DEN-EXT-SG"),
  {
    code: "DEN-EXT-SG",
    quantityLow: 0,
    quantityHigh: 4,
    dependsOn: "the X-rays show the upper back teeth need to come out",
    notesSpan: "4 teeth with root resorption, need surgical extraction",
    ownerWording: "Removing up to four damaged teeth",
  },
  {
    code: "MED-ANTIB-TAB",
    quantityLow: 1,
    quantityHigh: 1,
    notesSpan: "Abx for 7 days",
    ownerWording: "Antibiotic tablets for a week",
  },
];

/** U4's explanation of the update, in the shape U4 keeps it (its audit event's output). */
export const BRAMBLE_EXPLANATION =
  "The X-rays showed damaged roots on four teeth, so your vet recommends removing up to four teeth rather than two, with a week of antibiotic tablets afterwards.";

/** A seeded PayPal id's prefix: no PayPal call is ever made about it. */
export const SEEDED_ID_PREFIX = "SEEDED";

/**
 * A PayPal-shaped id for a seeded hold.
 *
 * @returns The id.
 */
function seededId(): string {
  return `${SEEDED_ID_PREFIX}${randomBytes(6).toString("hex").toUpperCase()}`.slice(0, 17);
}

/**
 * Bramble's case held at its first estimate, written as rows the database
 * accepts (U3's "To U9"), with no PayPal call: the hold's ids are seeded.
 *
 * @param db - The run's database.
 * @returns The case and its first estimate's link.
 */
export async function heldBrambleEstimate(db: Database["db"]): Promise<SentCase> {
  const sent = await sentBrambleEstimate(db);
  await db.transaction(async (tx) => {
    const authorizationId = seededId();
    const [made] = await tx
      .insert(hold)
      .values({
        id: sent.versionId,
        practiceId: sent.practiceId,
        caseId: sent.caseId,
        versionNumber: 1,
        versionHighPence: 92_700,
        heldBeforePence: 0,
        amountPence: 92_700,
        currencyCode: "GBP",
        status: "authorised",
        paypalOrderId: seededId(),
        authorizationId,
        originalAuthorizationId: authorizationId,
        paymentKind: "paypal",
        authorisedAt: new Date(),
        confirmedAt: new Date(),
      })
      .returning();
    await tx.update(patientCase).set({ moneyState: "held" }).where(eq(patientCase.id, sent.caseId));
    await appendAuditEvent(tx, {
      practiceId: sent.practiceId,
      caseId: sent.caseId,
      actor: "owner",
      action: "hold.authorised",
      moneyStateBefore: "awaiting_owner",
      moneyStateAfter: "held",
      amount: { pence: made!.amountPence, currency: "GBP" },
      paypal: { orderId: made!.paypalOrderId, authorizationId },
      detail: { holdId: made!.id, versionNumber: 1, paymentKind: "paypal", seeded: true },
    });
  });
  return sent;
}

/**
 * Bramble's case held at its first estimate with the update sent, U4's
 * explanation kept as U4 keeps it, and the update's link.
 *
 * @param db - The run's database.
 * @returns The case, the first estimate's link and the update's.
 */
export async function brambleUpdate(
  db: Database["db"],
): Promise<{ first: SentCase; update: SentCase }> {
  const first = await heldBrambleEstimate(db);
  const fixture = { practiceId: first.practiceId, caseId: first.caseId };
  const draft = await makeEstimateVersion(db, {
    ...fixture,
    actor: "vet",
    lines: BRAMBLE_UPDATE_LINES,
  });
  await appendAuditEvent(db, {
    ...fixture,
    actor: "system",
    action: "estimate.update_drafted",
    model: {
      id: "gpt-6.1-sol",
      inputSha256: "0".repeat(64),
      output: { explanation: BRAMBLE_EXPLANATION, explanationFellBack: null },
    },
    detail: { versionId: draft.id, number: draft.number, seeded: true },
  });
  await sendEstimate(db, { practiceId: first.practiceId, versionId: draft.id, actor: "vet" });
  const link = await ownerLink(
    db,
    { ...fixture, versionId: draft.id },
    { secret: browserSecret(), now: new Date() },
  );
  return { first, update: { ...fixture, versionId: draft.id, path: link.path, token: link.token } };
}
