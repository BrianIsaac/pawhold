import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { capture, hold, patientCase } from "@/db/schema";
import { loadDischargeView } from "@/discharge/bill";
import { confirmBill, runDischarge } from "@/discharge/confirm";
import { refundOnCase } from "@/discharge/refund";
import { type EstimateLineInput, makeEstimateVersion } from "@/estimate/version";
import { authoriseHold, orderHold, sendEstimate } from "@/money/holds";
import { reconcileWebhookEvent } from "@/money/reconcile";
import { ownerLink } from "@/owner/link";
import { createPayPalClient, type PayPalClient } from "@/paypal/client";

import { storeDelivery } from "../../support/webhook-delivery";
import { BRAMBLE_LINES, BRAMBLE_UPDATE_LINES, browserSecret } from "../owner/support/cases";

/*
 * The discharge walks' cases: held for real against U3's PayPal double, which
 * `pnpm test:browser` starts beside the server when the run has no sandbox
 * credentials. The owner's approval is played through the double's control
 * route; no PayPal id here is seeded, so the server's discharge captures and
 * voids at the double as it would at PayPal.
 */

/** The double's address, or null when the run talks to PayPal's sandbox instead. */
export const DOUBLE_URL = process.env.PAWHOLD_BROWSER_PAYPAL_DOUBLE_URL ?? null;

/**
 * A client of the double, as the server's own is.
 *
 * @returns The client.
 * @throws Error when the run has no double.
 */
function doubleClient(): PayPalClient {
  if (!DOUBLE_URL) {
    throw new Error("the discharge walks need the PayPal double that `pnpm test:browser` starts");
  }
  return createPayPalClient({
    clientId: "pawhold-browser-double",
    clientSecret: "pawhold-browser-double",
    environment: "sandbox",
    baseUrl: DOUBLE_URL,
  });
}

/**
 * Sends a version and has the owner authorise its hold at the double.
 *
 * @param db - The run's database.
 * @param fixture - The practice and the case.
 * @param fixture.practiceId - The practice.
 * @param fixture.caseId - The case.
 * @param lines - The version's lines.
 * @param kind - How the owner paid.
 * @returns Resolves once the hold is authorised.
 */
async function heldAtTheDouble(
  db: Database["db"],
  fixture: { practiceId: string; caseId: string },
  lines: readonly EstimateLineInput[],
  kind: "paypal" | "card",
): Promise<void> {
  const deps = { db, paypal: doubleClient() };
  const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: [...lines] });
  await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
  const { hold: ordered } = await orderHold(deps, { ...fixture, versionId: draft.id });
  const approved = await fetch(`${DOUBLE_URL}/__double/orders/${ordered.paypalOrderId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  if (approved.status !== 204) {
    throw new Error(`the double did not approve order ${ordered.paypalOrderId}`);
  }
  await authoriseHold(deps, { ...fixture, holdId: ordered.id });
}

/** Pepper's case, held twice: Bramble's estimate (£927.00) on PayPal and its update (£228.00) by card. */
export interface TwoHoldCase {
  readonly practiceId: string;
  readonly caseId: string;
}

/**
 * A case in the signed-in practice held on two holds at the double: the
 * dental estimate the owner's walks use, then its update.
 *
 * @param db - The run's database.
 * @param practiceId - The practice the walk signed in to.
 * @returns The case.
 */
export async function twoHoldCase(db: Database["db"], practiceId: string): Promise<TwoHoldCase> {
  const [kase] = await db
    .insert(patientCase)
    .values({
      practiceId,
      patientName: "Pepper",
      ownerName: "Sam Patel",
      procedure: "Dental under anaesthetic",
      vetName: "Rowan Hale",
    })
    .returning();
  const fixture = { practiceId, caseId: kase!.id };
  await heldAtTheDouble(db, fixture, BRAMBLE_LINES, "paypal");
  await heldAtTheDouble(db, fixture, BRAMBLE_UPDATE_LINES, "card");
  return fixture;
}

/**
 * PayPal's webhooks for what the discharge did, stored as the listener stores
 * them and reconciled as it reconciles them: `PAYMENT.CAPTURE.COMPLETED` for
 * each capture and `PAYMENT.AUTHORIZATION.VOIDED` for each voided hold, in the
 * order the holds were made. A walk cannot post a signed delivery to the
 * server (its certificate must come from PayPal's own host).
 *
 * @param db - The run's database.
 * @param caseId - The case.
 * @returns How many were delivered.
 */
export async function deliverDischargeWebhooks(
  db: Database["db"],
  caseId: string,
): Promise<number> {
  const holds = await db
    .select()
    .from(hold)
    .where(eq(hold.caseId, caseId))
    .orderBy(asc(hold.versionNumber));
  const ids = holds.map((one) => one.id);
  const captures =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(capture)
          .where(and(inArray(capture.holdId, ids), eq(capture.status, "completed")));
  let delivered = 0;
  for (const one of holds) {
    for (const taken of captures.filter((each) => each.holdId === one.id)) {
      await reconcileWebhookEvent(
        db,
        await storeDelivery(db, "PAYMENT.CAPTURE.COMPLETED", taken.paypalCaptureId),
      );
      delivered += 1;
    }
    if (one.status === "voided" && one.authorizationId) {
      await reconcileWebhookEvent(
        db,
        await storeDelivery(db, "PAYMENT.AUTHORIZATION.VOIDED", one.authorizationId),
      );
      delivered += 1;
    }
  }
  return delivered;
}

/** Pepper's case discharged against the double, and its first hold's capture. */
export interface DischargedCase extends TwoHoldCase {
  readonly firstCaptureId: string;
}

/**
 * Pepper's two-hold case discharged against the double through this unit's
 * own path (confirmBill, then runDischarge), the bill as the confirm walk
 * makes it: three extractions, so £1,057.00 is captured and £98.00 released.
 *
 * @param db - The run's database.
 * @param practiceId - The practice the walk signed in to.
 * @returns The case and its first capture.
 */
export async function dischargedCase(
  db: Database["db"],
  practiceId: string,
): Promise<DischargedCase> {
  const kase = await twoHoldCase(db, practiceId);
  const view = await loadDischargeView(db, practiceId, kase.caseId);
  const quantities = Object.fromEntries(
    view.groups.flatMap((group) =>
      group.lines.map((line) => [line.estimateLineId, String(line.quantityLow)]),
    ),
  );
  const extractions = view.groups[1]!.lines.find((line) => line.code === "DEN-EXT-SG")!;
  quantities[extractions.estimateLineId] = "3";
  await confirmBill(db, {
    ...kase,
    quantities,
    extras: [],
    shown: { billedPence: 105_700, capturePence: [92_700, 13_000] },
  });
  await runDischarge({ db, paypal: doubleClient() }, kase);
  const [firstHold] = await db
    .select()
    .from(hold)
    .where(eq(hold.caseId, kase.caseId))
    .orderBy(asc(hold.versionNumber))
    .limit(1);
  const [taken] = await db.select().from(capture).where(eq(capture.holdId, firstHold!.id));
  return { ...kase, firstCaptureId: taken!.id };
}

/**
 * The owner's link to the case's first estimate, which opens the receipt once
 * the case is discharged (U6).
 *
 * @param db - The run's database.
 * @param kase - The case.
 * @returns The link's path, `/e/{token}`.
 */
export async function receiptPath(db: Database["db"], kase: TwoHoldCase): Promise<string> {
  const [firstHold] = await db
    .select()
    .from(hold)
    .where(eq(hold.caseId, kase.caseId))
    .orderBy(asc(hold.versionNumber))
    .limit(1);
  const link = await ownerLink(
    db,
    { practiceId: kase.practiceId, caseId: kase.caseId, versionId: firstHold!.id },
    { secret: browserSecret(), now: new Date() },
  );
  return link.path;
}

/**
 * Refunds part of the case's first charge at the double, through the case
 * page's own path (`refundOnCase`).
 *
 * @param db - The run's database.
 * @param kase - The discharged case.
 * @param amount - The amount, in pounds as typed.
 * @param reason - Why.
 * @returns Resolves once refunded.
 */
export async function refundAtTheDouble(
  db: Database["db"],
  kase: DischargedCase,
  amount: string,
  reason: string,
): Promise<void> {
  await refundOnCase(
    { db, paypal: doubleClient() },
    {
      practiceId: kase.practiceId,
      caseId: kase.caseId,
      captureId: kase.firstCaptureId,
      amount,
      reason,
    },
  );
}
