import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hold, patientCase, session } from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { pruneJudgeSessions } from "@/judge/cleanup";
import { startJudgeSession, type StartedSession } from "@/judge/session";
import { authoriseHold, orderHold } from "@/money/holds";
import { createPayPalClient, type PayPalClient } from "@/paypal/client";
import { getAuthorization, voidAuthorization } from "@/paypal/payments";
import { paypalRequestId } from "@/paypal/request-id";

import { type Buyer, createBrowserBuyer } from "../../probes/buyer";
import { probeEnvironment, secretsOf } from "../../probes/environment";
import { CANCEL_URL, RETURN_URL } from "../../probes/orders";
import { retryingFetch } from "../../probes/retry";
import { seedFictionalPractice } from "../../seed/practice";
import { OWNER_DOOR_CASE } from "../../seed/showcase/cases";
import { connectTestDatabase } from "../support/database";

/*
 * The judge-mode clean-up against PayPal's sandbox (U9): a judge's session
 * eight days old, whose owner door's estimate U0's headless buyer approved
 * and pawhold authorised, is pruned by the clean-up, which voids the hold at
 * PayPal first. Skipped without PAYPAL_CLIENT_ID. Nothing is left held: the
 * end of the run voids anything still standing and fails if it cannot.
 */

const configured = Boolean(process.env.PAYPAL_CLIENT_ID);
const { db } = connectTestDatabase();
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!configured)("the judge-mode clean-up against PayPal's sandbox (U9)", () => {
  let paypal: PayPalClient;
  let buyer: Buyer;
  let judge: StartedSession | undefined;

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
    if (!paypal || !judge) {
      return;
    }
    const holds = await db.select().from(hold).where(eq(hold.practiceId, judge.practiceId));
    const stillHeld: string[] = [];
    for (const one of holds.filter((made) => made.authorizationId !== null)) {
      if (one.paypalOrderId.startsWith("SEEDED")) {
        continue;
      }
      const read = await getAuthorization(paypal, one.authorizationId!);
      if (read.status === "CREATED" || read.status === "PARTIALLY_CAPTURED") {
        await voidAuthorization(
          paypal,
          one.authorizationId!,
          paypalRequestId({ caseId: one.caseId, holdId: one.id, step: "void.cleanup" }),
        );
      }
      const after = await getAuthorization(paypal, one.authorizationId!);
      if (after.status === "CREATED" || after.status === "PARTIALLY_CAPTURED") {
        stillHeld.push(`${one.authorizationId} (${after.status})`);
      }
    }
    expect(stillHeld, "the run must leave nothing held").toEqual([]);
  });

  it("voids at PayPal the hold a judge authorised through the owner's door, then prunes the session", async () => {
    const now = new Date();
    judge = await startJudgeSession(
      { db, seed: seedFictionalPractice, now: () => now.getTime() - 8 * DAY_MS },
      "owner",
    );
    const practiceId = judge.practiceId;
    const [kase] = await db
      .select({ id: patientCase.id })
      .from(patientCase)
      .where(
        and(
          eq(patientCase.practiceId, practiceId),
          eq(patientCase.patientName, OWNER_DOOR_CASE.patientName),
        ),
      );
    const caseId = kase!.id;
    const version = (await caseEstimateVersions(db, practiceId, caseId)).at(-1)!;
    const ordered = await orderHold(
      { db, paypal },
      {
        practiceId,
        caseId,
        versionId: version.id,
        experience: {
          brandName: "pawhold integration",
          locale: "en-GB",
          returnUrl: RETURN_URL,
          cancelUrl: CANCEL_URL,
        },
      },
    );
    await buyer.approve(ordered.approvalUrl!);
    const authorised = await authoriseHold(
      { db, paypal },
      { practiceId, caseId, holdId: ordered.hold.id },
    );
    expect((await getAuthorization(paypal, authorised.authorizationId!)).status).toBe("CREATED");

    const report = await pruneJudgeSessions({ db, paypal, now, practiceIds: [practiceId] });

    expect(report).toEqual({ pruned: [judge.sessionId], voided: [authorised.id], waiting: [] });
    expect((await getAuthorization(paypal, authorised.authorizationId!)).status).toBe("VOIDED");
    const [after] = await db.select().from(hold).where(eq(hold.id, authorised.id));
    expect(after?.status).toBe("voided");
    expect(await db.select().from(session).where(eq(session.id, judge.sessionId))).toEqual([]);
  });
});
