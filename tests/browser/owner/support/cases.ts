import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { appendAuditEvent } from "@/audit/writer";
import { createDatabase, type Database } from "@/db/client";
import {
  allocation,
  bill,
  billLine,
  capture,
  hold,
  patientCase,
  practice,
  refund,
} from "@/db/schema";
import {
  type EstimateLineInput,
  type EstimateVersionView,
  loadEstimateVersion,
  makeEstimateVersion,
} from "@/estimate/version";
import { allocateBill, approvalsByHold } from "@/money/allocation";
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
    throw new Error("the browser suite's secret is set by `pnpm test:browser`");
  }
  return secret;
}

/**
 * A practice seeded as a judge's is, with Bramble's case (its vet Rowan Hale,
 * as U5's showcase case names) and no estimate yet.
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
        species: "dog",
        ownerName: "Sam Carter",
        procedure: "Dental under anaesthetic",
        vetName: "Rowan Hale",
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

/** What Bramble's bill did: three extractions of the four approved, the rest as estimated. */
const BRAMBLE_BILL: readonly { readonly code: string; readonly quantity: number }[] = [
  { code: "LAB-PRE", quantity: 1 },
  { code: "GA-DENT", quantity: 1 },
  { code: "DEN-CHART", quantity: 1 },
  { code: "DEN-SP", quantity: 1 },
  { code: "IMG-XR-DENT", quantity: 1 },
  { code: "DEN-EXT-SG", quantity: 3 },
  { code: "MED-NSAID-ORAL", quantity: 1 },
  { code: "MED-ANTIB-TAB", quantity: 1 },
];

/** The goodwill refund after discharge. */
export const BRAMBLE_REFUND_PENCE = 2_500;

/**
 * Bramble's case discharged and then part refunded, as the seed would show
 * a judge (U3's "To U9"): the first estimate and the update each held (on a
 * card and on PayPal), the bill signed off and allocated by U3's own
 * allocator, each hold captured once and final, and £25.00 refunded as
 * goodwill. Written as rows in one transaction, so U3's deferred checks of
 * the money rules hold them to the same sums the lifecycle would; no PayPal
 * call is made (the ids are seeded).
 *
 * @param db - The run's database.
 * @returns The first estimate's link and the update's.
 */
export async function refundedBramble(
  db: Database["db"],
): Promise<{ first: SentCase; update: SentCase }> {
  const { first, update } = await brambleUpdate(db);
  const versions = await Promise.all(
    [first.versionId, update.versionId].map(
      async (id) => (await loadEstimateVersion(db, first.practiceId, id))!,
    ),
  );
  const [v1, v2] = versions as [EstimateVersionView, EstimateVersionView];
  const holdIds = [v1.id, v2.id];
  const amounts = [v1.totals.highPence, v2.totals.highPence - v1.totals.highPence];
  const billLines = BRAMBLE_BILL.map(({ code, quantity }) => {
    const line = v2.lines.find((one) => one.code === code)!;
    return { line, quantity, amountPence: line.unitPricePence * quantity };
  });
  const plan = allocateBill(
    approvalsByHold(
      versions.map((version) => ({
        holdId: version.id,
        items: version.lines.map((line) => ({ code: line.code, highPence: line.highPence })),
      })),
    ),
    billLines.map(({ line, amountPence }) => ({ code: line.code, amountPence })),
  );
  const now = new Date();

  await db.transaction(async (tx) => {
    const authorizationId = seededId();
    await tx.insert(hold).values({
      id: v2.id,
      practiceId: first.practiceId,
      caseId: first.caseId,
      versionNumber: v2.number,
      versionHighPence: v2.totals.highPence,
      heldBeforePence: amounts[0]!,
      amountPence: amounts[1]!,
      currencyCode: "GBP",
      status: "authorised",
      paypalOrderId: seededId(),
      authorizationId,
      originalAuthorizationId: authorizationId,
      paymentKind: "card",
      authorisedAt: now,
      confirmedAt: now,
    });
    const [signed] = await tx
      .insert(bill)
      .values({
        practiceId: first.practiceId,
        caseId: first.caseId,
        currencyCode: "GBP",
        totalPence: plan.billedPence,
        signedOffBy: "vet",
      })
      .returning();
    const lines = await tx
      .insert(billLine)
      .values(
        billLines.map(({ line, quantity }, at) => ({
          billId: signed!.id,
          position: at + 1,
          estimateLineId: line.id,
          quantity,
          unitPricePence: line.unitPricePence,
        })),
      )
      .returning();
    await tx.insert(allocation).values(
      plan.byLine.flatMap((parts, at) =>
        parts.map((part) => ({
          billLineId: lines[at]!.id,
          holdId: part.holdId,
          amountPence: part.amountPence,
        })),
      ),
    );
    const captures = [];
    for (const holdId of holdIds) {
      const [held] = await tx.select().from(hold).where(eq(hold.id, holdId));
      const [taken] = await tx
        .insert(capture)
        .values({
          holdId,
          sequence: 1,
          paypalCaptureId: seededId(),
          authorizationId: held!.authorizationId!,
          amountPence: plan.byHold.get(holdId) ?? 0,
          currencyCode: "GBP",
          finalCapture: true,
          status: "completed",
          capturedAt: now,
          confirmedAt: now,
        })
        .returning();
      captures.push(taken!);
      await tx.update(hold).set({ status: "captured", closedAt: now }).where(eq(hold.id, holdId));
      await appendAuditEvent(tx, {
        practiceId: first.practiceId,
        caseId: first.caseId,
        actor: "system",
        action: "hold.captured",
        amount: { pence: taken!.amountPence, currency: "GBP" },
        paypal: {
          orderId: held!.paypalOrderId,
          authorizationId: held!.authorizationId!,
          captureId: taken!.paypalCaptureId,
        },
        detail: {
          holdId,
          releasedPence: held!.amountPence - taken!.amountPence,
          seeded: true,
        },
      });
    }
    await tx.insert(refund).values({
      captureId: captures[0]!.id,
      sequence: 1,
      amountPence: BRAMBLE_REFUND_PENCE,
      currencyCode: "GBP",
      reason: "Goodwill: the discharge ran late",
      requestedBy: "vet",
      status: "completed",
      paypalRefundId: seededId(),
      refundedAt: now,
      confirmedAt: now,
    });
    await tx
      .update(patientCase)
      .set({ moneyState: "refunded" })
      .where(eq(patientCase.id, first.caseId));
  });
  return { first, update };
}
