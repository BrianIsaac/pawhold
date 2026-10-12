import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { capture, hold, patientCase } from "@/db/schema";
import { type EstimateLineInput, makeEstimateVersion } from "@/estimate/version";
import { authoriseHold, orderHold, sendEstimate } from "@/money/holds";
import { reconcileWebhookEvent } from "@/money/reconcile";
import { createPayPalClient, type PayPalClient } from "@/paypal/client";

import { storeDelivery } from "../../support/webhook-delivery";
import { BRAMBLE_LINES, BRAMBLE_UPDATE_LINES } from "../owner/support/cases";

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
