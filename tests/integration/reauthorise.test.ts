import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { hold, patientCase, practice } from "@/db/schema";
import { importPriceList } from "@/estimate/price-list";
import { makeEstimateVersion, sendEstimateVersion } from "@/estimate/version";
import { HONOUR_PERIOD_MS, reauthoriseHolds } from "@/jobs/reauthorise";
import { createPayPalClient, type PayPalClient } from "@/paypal/client";
import { getAuthorization, parsePayPalTime, pence, voidAuthorization } from "@/paypal/payments";
import { paypalRequestId } from "@/paypal/request-id";

import { probeEnvironment } from "../../probes/environment";
import { retryingFetch } from "../../probes/retry";
import { connectTestDatabase } from "../support/database";

/*
 * Plan 5, U3's acceptance: "a PayPal hold made on 13 October reauthorises
 * when the job runs on or after 17 October". Owed to P5 (b): it needs a
 * wallet hold at least three days old, so it adopts one standing in the
 * sandbox (made by `pnpm probes P5A`, which keeps one per run) into a case of
 * its own and runs the reauthorisation job on it, against the sandbox. It
 * then records what PayPal says of the original authorisation (undocumented,
 * U3's finding 2) and voids whatever is still held. Skipped unless
 * U3_STANDING_AUTHORIZATION_ID and U3_STANDING_ORDER_ID name the hold.
 */

const standing = {
  authorizationId: process.env.U3_STANDING_AUTHORIZATION_ID,
  orderId: process.env.U3_STANDING_ORDER_ID,
};
const configured = Boolean(
  process.env.PAYPAL_CLIENT_ID && standing.authorizationId && standing.orderId,
);
const { db } = connectTestDatabase();

describe.skipIf(!configured)("the reauthorisation job against the sandbox (owed to P5 (b))", () => {
  let paypal: PayPalClient;
  const toVoid: { caseId: string; holdId: string; authorizationId: string }[] = [];

  afterAll(async () => {
    for (const one of toVoid) {
      const read = await getAuthorization(paypal, one.authorizationId);
      if (read.status === "CREATED" || read.status === "PARTIALLY_CAPTURED") {
        await voidAuthorization(
          paypal,
          one.authorizationId,
          paypalRequestId({ caseId: one.caseId, holdId: one.holdId, step: "void.cleanup" }),
        );
      }
      expect((await getAuthorization(paypal, one.authorizationId)).status).not.toBe("CREATED");
    }
  });

  it("reauthorises a wallet hold past day 3 once, the new authorisation holding the amount", async () => {
    const env = probeEnvironment.parse(process.env);
    paypal = createPayPalClient({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      environment: "sandbox",
      timeoutMs: 90_000,
      fetch: retryingFetch(fetch, { attempts: 4, delayMs: 2_000 }),
    });
    const original = await getAuthorization(paypal, standing.authorizationId!);
    expect(original.status, "the standing hold must still hold").toBe("CREATED");
    const authorisedAt = parsePayPalTime(original.create_time!);
    expect(
      Date.now() - authorisedAt.getTime(),
      "the standing hold must be past day 3",
    ).toBeGreaterThanOrEqual(HONOUR_PERIOD_MS);
    const amountPence = pence(original.amount)!;

    // A case of its own whose estimate tops out at the standing hold's amount.
    const [made] = await db
      .insert(practice)
      .values({ name: "Reauthorisation practice", kind: "judge" })
      .returning();
    const practiceId = made!.id;
    await importPriceList(db, {
      practiceId,
      actor: "system",
      sourceName: "standing-hold.csv",
      csv: `code,name,category,unit,unit_price_pence\nHOLD-STANDING,Standing hold,procedure,procedure,${amountPence}`,
    });
    const [kase] = await db
      .insert(patientCase)
      .values({
        practiceId,
        patientName: "Standing",
        species: "dog",
        ownerName: "Sandbox Buyer",
        procedure: "P5",
      })
      .returning();
    const draft = await makeEstimateVersion(db, {
      practiceId,
      caseId: kase!.id,
      actor: "vet",
      lines: [{ code: "HOLD-STANDING", quantityLow: 1, quantityHigh: 1 }],
    });
    const version = await sendEstimateVersion(db, {
      practiceId,
      versionId: draft.id,
      actor: "vet",
    });
    await db.update(patientCase).set({ moneyState: "held" }).where(eq(patientCase.id, kase!.id));
    await db.insert(hold).values({
      id: version.id,
      practiceId,
      caseId: kase!.id,
      versionNumber: version.number,
      versionHighPence: version.totals.highPence,
      heldBeforePence: 0,
      amountPence,
      currencyCode: "GBP",
      status: "authorised",
      paypalOrderId: standing.orderId!,
      authorizationId: original.id,
      originalAuthorizationId: original.id,
      paymentKind: "paypal",
      authorisedAt,
      expiresAt: original.expiration_time ? parsePayPalTime(original.expiration_time) : null,
    });
    toVoid.push({ caseId: kase!.id, holdId: version.id, authorizationId: original.id });

    const report = await reauthoriseHolds({ db, paypal, practiceId });
    const again = await reauthoriseHolds({ db, paypal, practiceId });

    expect(report.reauthorised).toEqual([version.id]);
    expect(again.reauthorised).toEqual([]);
    const [renewed] = await db.select().from(hold).where(eq(hold.id, version.id));
    expect(renewed!.authorizationId).not.toBe(original.id);
    toVoid.push({
      caseId: kase!.id,
      holdId: version.id,
      authorizationId: renewed!.authorizationId!,
    });
    const fresh = await getAuthorization(paypal, renewed!.authorizationId!);
    expect(fresh.status).toBe("CREATED");
    expect(pence(fresh.amount)).toBe(amountPence);
    const before = await getAuthorization(paypal, original.id);
    // Undocumented (U3's finding 2): what the replaced authorisation reads.
    console.info("U3 P5 (b): the original authorisation now reads", before.status);
  });
});
