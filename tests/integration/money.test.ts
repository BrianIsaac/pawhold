import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { capture, hold } from "@/db/schema";
import {
  type EstimateVersionView,
  loadEstimateVersion,
  makeEstimateVersion,
} from "@/estimate/version";
import { discharge, dischargeCase } from "@/money/discharge";
import { MoneyError } from "@/money/errors";
import { authoriseHold, orderHold, sendEstimate } from "@/money/holds";
import { refundCaptured } from "@/money/refunds";
import { caseMoney } from "@/money/view";
import {
  createPayPalClient,
  type PayPalClient,
  PayPalTransportError,
  type PostOptions,
} from "@/paypal/client";
import { getOrder } from "@/paypal/orders";
import { getAuthorization, getCapture, voidAuthorization } from "@/paypal/payments";
import { paypalRequestId } from "@/paypal/request-id";

import { type Buyer, createBrowserBuyer } from "../../probes/buyer";
import { probeEnvironment, secretsOf } from "../../probes/environment";
import { CANCEL_URL, RETURN_URL } from "../../probes/orders";
import { retryingFetch } from "../../probes/retry";
import { connectTestDatabase } from "../support/database";
import {
  DENTAL_LINES,
  DENTAL_UPDATE_LINES,
  makeDentalCase,
  type MoneyFixture,
} from "../support/money";

/*
 * The money lifecycle against PayPal's sandbox, the owner's approvals made by
 * U0's headless buyer: authorise, a second hold, capture in part and final,
 * a capture whose answer was lost retried with the same request id, void,
 * refund, and an expired hold by negative testing. Skipped without
 * PAYPAL_CLIENT_ID. Every hold it makes is closed by the end: the clean-up
 * voids whatever is still held and fails the run if anything stays held.
 */

const configured = Boolean(process.env.PAYPAL_CLIENT_ID);
const { db } = connectTestDatabase();

/**
 * A client whose answer to the first matching POST is lost on the way back:
 * PayPal acts, the caller sees no answer.
 *
 * @param inner - The real client.
 * @param path - Which POSTs.
 * @returns The client.
 */
function losingFirstAnswer(
  inner: PayPalClient,
  path: RegExp,
): PayPalClient & { lost: () => boolean } {
  let lost = false;
  return {
    get: (p, options) => inner.get(p, options),
    post: async <T>(p: Parameters<PayPalClient["post"]>[0], options: PostOptions<T>) => {
      const answer = await inner.post(p, options);
      if (!lost && path.test(p)) {
        lost = true;
        throw new PayPalTransportError("POST", p, new Error("the test dropped PayPal's answer"));
      }
      return answer;
    },
    lost: () => lost,
  };
}

/**
 * A client that adds headers to matching POSTs, for negative testing.
 *
 * @param inner - The real client.
 * @param path - Which POSTs.
 * @param headers - The headers.
 * @returns The client.
 */
function withHeaders(
  inner: PayPalClient,
  path: RegExp,
  headers: Record<string, string>,
): PayPalClient {
  return {
    get: (p, options) => inner.get(p, options),
    post: <T>(p: Parameters<PayPalClient["post"]>[0], options: PostOptions<T>) =>
      path.test(p)
        ? inner.post(p, {
            ...options,
            headers: { ...options.headers, ...headers },
          } as PostOptions<T>)
        : inner.post(p, options),
  };
}

describe.skipIf(!configured)("the money lifecycle against PayPal's sandbox (U3, item 8)", () => {
  let paypal: PayPalClient;
  let buyer: Buyer;
  const practices: string[] = [];

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
    if (!paypal || practices.length === 0) {
      return;
    }
    const holds = await db.select().from(hold).where(inArray(hold.practiceId, practices));
    const stillHeld: string[] = [];
    for (const one of holds) {
      // An order whose authorise answer was lost holds an authorisation pawhold never recorded.
      const unrecorded =
        one.authorizationId === null
          ? ((await getOrder(paypal, one.paypalOrderId)).purchase_units?.flatMap(
              (unit) => unit.payments?.authorizations?.map((found) => found.id) ?? [],
            ) ?? [])
          : [];
      // The original parent first: a reauthorisation is voided only through it (CANNOT_BE_VOIDED).
      const ids = [
        ...new Set([one.originalAuthorizationId, one.authorizationId, ...unrecorded]),
      ].filter((id): id is string => id !== null);
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
   * A new case in a practice of its own, with the dental price list.
   *
   * @returns The practice and the case.
   */
  async function newCase(): Promise<MoneyFixture> {
    const fixture = await makeDentalCase(db, "Integration practice");
    practices.push(fixture.practiceId);
    return fixture;
  }

  /**
   * Sends a version, has the buyer approve its order on PayPal's checkout,
   * and authorises it.
   *
   * @param fixture - The case.
   * @param lines - The version's lines.
   * @returns The version.
   */
  async function sendAndHold(
    fixture: MoneyFixture,
    lines = DENTAL_LINES,
  ): Promise<EstimateVersionView> {
    const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines });
    await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
    const ordered = await orderHold(
      { db, paypal },
      {
        ...fixture,
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
    await authoriseHold({ db, paypal }, { ...fixture, holdId: ordered.hold.id });
    return (await loadEstimateVersion(db, fixture.practiceId, draft.id))!;
  }

  describe("a two-hold case, discharged in part and refunded", () => {
    let fixture: MoneyFixture;
    let first: EstimateVersionView;
    let update: EstimateVersionView;

    it("authorises the estimate's top on the buyer's PayPal, its lines on the order (D3, 3.3)", async () => {
      fixture = await newCase();
      first = await sendAndHold(fixture);

      const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
      expect(money.state).toBe("held");
      const [held] = money.holds;
      expect(held).toMatchObject({ status: "authorised", paymentKind: "paypal" });
      const read = await getAuthorization(paypal, held!.authorizationId!);
      expect(read.status).toBe("CREATED");
      expect(read.amount).toMatchObject({ currency_code: "GBP", value: "773.00" });
      const order = await getOrder(paypal, held!.paypalOrderId);
      expect(order.status).toBe("COMPLETED");
    });

    it("holds the update's increase as a second hold while the first stands (P7)", async () => {
      update = await sendAndHold(fixture, DENTAL_UPDATE_LINES);

      const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
      expect(money.holds.map((one) => [one.status, one.amount.pence])).toEqual([
        ["authorised", 77_300],
        ["authorised", 15_500],
      ]);
      const read = await getAuthorization(paypal, money.holds[1]!.authorizationId!);
      expect(read.amount).toMatchObject({ currency_code: "GBP", value: "155.00" });
    });

    it("captures part of the first hold, final; a lost answer retried captures once; the update's hold is voided", async () => {
      const losing = losingFirstAnswer(paypal, /\/capture$/);
      const bill = [
        { estimateLineId: update.lines.find((l) => l.code === "GA-DENT")!.id, quantity: 1 },
      ];

      const lost = await discharge(
        { db, paypal: losing },
        { ...fixture, actor: "vet", lines: bill },
      ).catch((error: unknown) => error);
      expect(losing.lost()).toBe(true);
      expect(lost).toBeInstanceOf(MoneyError);
      expect((lost as MoneyError).reason).toBe("paypal_unavailable");

      const result = await dischargeCase({ db, paypal }, fixture);

      expect(result).toMatchObject({
        state: "released",
        capturedPence: 32_000,
        releasedPence: 45_300 + 15_500,
      });
      const [firstHold, updateHold] = result.holds;
      const order = await getOrder(paypal, firstHold!.paypalOrderId);
      const captures = (order.purchase_units ?? []).flatMap(
        (unit) => unit.payments?.captures ?? [],
      );
      expect(captures).toHaveLength(1);
      expect(captures[0]).toMatchObject({ status: "COMPLETED", final_capture: true });
      expect((await getAuthorization(paypal, firstHold!.authorizationId!)).status).toBe("CAPTURED");
      const voided = await getAuthorization(paypal, updateHold!.authorizationId!);
      expect(voided.status).toBe("VOIDED");
      expect(voided.amount).toMatchObject({ value: "155.00" });
      expect(first.id).toBe(firstHold!.id);
    });

    it("refunds part of the capture, then the rest", async () => {
      const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
      const [taken] = await db.select().from(capture).where(eq(capture.holdId, money.holds[0]!.id));

      const part = await refundCaptured(
        { db, paypal },
        { ...fixture, captureId: taken!.id, amountPence: 1_000, reason: "goodwill", actor: "vet" },
      );
      const rest = await refundCaptured(
        { db, paypal },
        { ...fixture, captureId: taken!.id, reason: "correction", actor: "vet" },
      );

      expect([part.status, rest.status]).toEqual(["completed", "completed"]);
      expect(rest.amountPence).toBe(31_000);
      expect((await getCapture(paypal, taken!.paypalCaptureId)).status).toBe("REFUNDED");
      expect((await caseMoney(db, fixture.practiceId, fixture.caseId)).state).toBe("refunded");
    });
  });

  it("records a hold PayPal will not capture as expired (negative testing), capturing nothing", async () => {
    const fixture = await newCase();
    const version = await sendAndHold(fixture, [
      { code: "CON-STD", quantityLow: 1, quantityHigh: 1 },
    ]);
    const expiring = withHeaders(paypal, /\/capture$/, {
      "paypal-mock-response": JSON.stringify({ mock_application_codes: "AUTHORIZATION_EXPIRED" }),
    });

    const result = await discharge(
      { db, paypal: expiring },
      { ...fixture, actor: "vet", lines: [{ estimateLineId: version.lines[0]!.id, quantity: 1 }] },
    );

    expect(result).toMatchObject({ capturedPence: 0, unpaidPence: 4_800 });
    expect(result.holds[0]!.status).toBe("expired");
    // The mock captured nothing: the authorisation still holds, and the clean-up voids it.
    expect((await getAuthorization(paypal, result.holds[0]!.authorizationId!)).status).toBe(
      "CREATED",
    );
  });
});
