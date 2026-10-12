import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditEvent, capture, hold } from "@/db/schema";
import { loadDischargeView } from "@/discharge/bill";
import { confirmBill, runDischarge } from "@/discharge/confirm";
import { dischargeProgress } from "@/discharge/progress";
import { type EstimateLineInput, makeEstimateVersion } from "@/estimate/version";
import { authoriseHold, orderHold, sendEstimate } from "@/money/holds";
import { caseMoney } from "@/money/view";
import { createPayPalClient, type PayPalClient } from "@/paypal/client";
import { getOrder } from "@/paypal/orders";
import { getAuthorization, getCapture, voidAuthorization } from "@/paypal/payments";
import { paypalRequestId } from "@/paypal/request-id";

import { type Buyer, createBrowserBuyer } from "../../probes/buyer";
import { probeEnvironment, secretsOf } from "../../probes/environment";
import { CANCEL_URL, RETURN_URL } from "../../probes/orders";
import { retryingFetch } from "../../probes/retry";
import { quantitiesOf } from "../discharge/support";
import { connectTestDatabase } from "../support/database";
import {
  DENTAL_LINES,
  DENTAL_UPDATE_LINES,
  makeDentalCase,
  type MoneyFixture,
} from "../support/money";

/*
 * U7's acceptance against PayPal's sandbox: a two-hold case, both holds
 * approved by U0's headless GB buyer, discharged through the discharge page's
 * own path (confirmBill, then runDischarge) to the exact bill across both
 * holds, each closed by a final capture below it so PayPal releases the rest.
 * Skipped without PAYPAL_CLIENT_ID. Every hold it makes is closed by the end:
 * the clean-up voids whatever is still held and fails the run if anything
 * stays held. U0's standing holds and the deployment's webhook are never
 * read or touched.
 */

const configured = Boolean(process.env.PAYPAL_CLIENT_ID);
const { db } = connectTestDatabase();

describe.skipIf(!configured)("discharge against PayPal's sandbox (U7)", () => {
  let paypal: PayPalClient;
  let buyer: Buyer;
  let fixture: MoneyFixture | null = null;

  beforeAll(() => {
    const env = probeEnvironment.parse(process.env);
    // U0's decision 6: a request that got no answer is sent again when that
    // cannot act twice (a GET, the token, a POST with its request id).
    paypal = createPayPalClient({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      environment: "sandbox",
      timeoutMs: 90_000,
      fetch: retryingFetch(fetch, { attempts: 4, delayMs: 2_000 }),
    });
    buyer = createBrowserBuyer(
      { email: env.PAYPAL_SANDBOX_BUYER_EMAIL, password: env.PAYPAL_SANDBOX_BUYER_PASSWORD },
      env.PAYPAL_CLIENT_ID,
      secretsOf(env),
    );
  });

  afterAll(async () => {
    if (!paypal || !fixture) {
      return;
    }
    const holds = await db.select().from(hold).where(eq(hold.caseId, fixture.caseId));
    const stillHeld: string[] = [];
    for (const one of holds) {
      // An order whose authorise answer was lost holds an authorisation pawhold never recorded.
      const unrecorded =
        one.authorizationId === null
          ? ((await getOrder(paypal, one.paypalOrderId)).purchase_units?.flatMap(
              (unit) => unit.payments?.authorizations?.map((found) => found.id) ?? [],
            ) ?? [])
          : [];
      const ids = [...new Set([one.authorizationId, ...unrecorded])].filter(
        (id): id is string => id !== null,
      );
      for (const id of ids) {
        const read = await getAuthorization(paypal, id);
        if (read.status === "CREATED" || read.status === "PARTIALLY_CAPTURED") {
          await voidAuthorization(
            paypal,
            id,
            paypalRequestId({ caseId: one.caseId, holdId: one.id, step: "void.cleanup" }),
          );
        }
        const after = await getAuthorization(paypal, id);
        if (after.status === "CREATED" || after.status === "PARTIALLY_CAPTURED") {
          stillHeld.push(`${id} (${after.status})`);
        }
      }
    }
    expect(stillHeld, "the run must leave nothing held").toEqual([]);
  });

  /**
   * Sends a version, has the buyer approve its order on PayPal's checkout,
   * and authorises it.
   *
   * @param kase - The case.
   * @param lines - The version's lines.
   * @returns Resolves once held.
   */
  async function sendAndHold(kase: MoneyFixture, lines: EstimateLineInput[]): Promise<void> {
    const draft = await makeEstimateVersion(db, { ...kase, actor: "vet", lines });
    await sendEstimate(db, { practiceId: kase.practiceId, versionId: draft.id, actor: "vet" });
    const ordered = await orderHold(
      { db, paypal },
      {
        ...kase,
        versionId: draft.id,
        experience: {
          brandName: "pawhold integration",
          locale: "en-GB",
          returnUrl: RETURN_URL,
          cancelUrl: CANCEL_URL,
        },
      },
    );
    await buyer.approve(ordered.approvalUrl!);
    await authoriseHold({ db, paypal }, { ...kase, holdId: ordered.hold.id });
  }

  it("a seeded two-hold case discharges to the exact bill across both holds with the remainder released, the audit events in order", async () => {
    fixture = await makeDentalCase(db, "Discharge integration practice");
    await sendAndHold(fixture, DENTAL_LINES);
    await sendAndHold(fixture, DENTAL_UPDATE_LINES);
    const held = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(held.holds.map((one) => [one.status, one.amount.pence])).toEqual([
      ["authorised", 77_300],
      ["authorised", 15_500],
    ]);

    // One extraction of the two; the rads but not the antibiotics.
    const view = await loadDischargeView(db, fixture.practiceId, fixture.caseId);
    const quantities = quantitiesOf(view);
    for (const line of view.groups.flatMap((group) => group.lines)) {
      if (line.code === "DEN-EXT") quantities[line.estimateLineId] = "1";
      if (line.code === "MED-AB") quantities[line.estimateLineId] = "0";
    }
    const plan = await confirmBill(db, {
      ...fixture,
      quantities,
      extras: [],
      shown: { billedPence: 79_500, capturePence: [67_500, 12_000] },
    });
    expect(plan.holds.map((one) => [one.capturePence, one.releasePence])).toEqual([
      [67_500, 9_800],
      [12_000, 3_500],
    ]);

    const result = await runDischarge({ db, paypal }, fixture);

    expect(result).toMatchObject({
      state: "released",
      billedPence: 79_500,
      capturedPence: 79_500,
      releasedPence: 13_300,
      unpaidPence: 0,
    });
    const captures = await db
      .select()
      .from(capture)
      .where(
        inArray(
          capture.holdId,
          result.holds.map((one) => one.id),
        ),
      );
    for (const [at, one] of result.holds.entries()) {
      // P2: a final capture below the hold leaves the authorisation CAPTURED, the rest released with no void.
      const read = await getAuthorization(paypal, one.authorizationId!);
      expect(read.status).toBe("CAPTURED");
      const taken = captures.filter((each) => each.holdId === one.id);
      expect(taken).toHaveLength(1);
      const paypalCapture = await getCapture(paypal, taken[0]!.paypalCaptureId);
      expect(paypalCapture).toMatchObject({
        status: "COMPLETED",
        final_capture: true,
        amount: { currency_code: "GBP", value: ["675.00", "120.00"][at] },
      });
    }

    const actions = await db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(eq(auditEvent.caseId, fixture.caseId))
      .orderBy(asc(auditEvent.id));
    const discharged = actions
      .map((one) => one.action)
      .filter(
        (action) =>
          action.startsWith("bill.") ||
          action.startsWith("hold.captured") ||
          action === "hold.voided",
      );
    expect(discharged).toEqual(["bill.signed_off", "hold.captured", "hold.captured"]);

    const progress = (await dischargeProgress(db, fixture.practiceId, fixture.caseId))!;
    expect(progress).toMatchObject({ finished: true, stalled: false, releasedPence: 13_300 });
    expect(progress.holds.map((one) => [one.capture?.pence, one.release?.pence])).toEqual([
      [67_500, 9_800],
      [12_000, 3_500],
    ]);
  });
});
