import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent, hold, patientCase } from "@/db/schema";
import { makeEstimateVersion } from "@/estimate/version";
import { MoneyError } from "@/money/errors";
import { authoriseHold, orderHold, sendEstimate, withdrawEstimate } from "@/money/holds";
import { caseMoney } from "@/money/view";
import { paypalRequestId } from "@/paypal/request-id";

import { connectTestDatabase } from "../support/database";
import { DENTAL_LINES, makeDentalCase, type MoneyFixture } from "../support/money";
import { startPayPalDouble } from "../support/paypal-double";
import { recordedAnswer } from "../support/recorded";

const { db } = connectTestDatabase();
const paypal = startPayPalDouble();

let fixture: MoneyFixture;

beforeEach(async () => {
  fixture = await makeDentalCase(db);
});

/**
 * The money lifecycle's dependencies, on the double.
 *
 * @returns The database and the PayPal client.
 */
function deps() {
  return { db, paypal: paypal.client() };
}

/**
 * Drafts and sends the dental estimate through the money lifecycle.
 *
 * @returns The sent version's id.
 */
async function sentEstimate(): Promise<string> {
  const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });
  const { version } = await sendEstimate(db, {
    practiceId: fixture.practiceId,
    versionId: draft.id,
    actor: "vet",
  });
  return version.id;
}

/**
 * The case's audit events after a given id, in order.
 *
 * @param afterId - The last event id seen.
 * @returns The events.
 */
async function eventsSince(afterId = 0) {
  const events = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.caseId, fixture.caseId))
    .orderBy(asc(auditEvent.id));
  return events.filter((event) => event.id > afterId);
}

/**
 * The id of the case's latest audit event.
 *
 * @returns The id, or 0.
 */
async function lastEventId(): Promise<number> {
  return (await eventsSince()).at(-1)?.id ?? 0;
}

/**
 * The reason a money operation was refused.
 *
 * @param operation - The operation.
 * @returns The refusal.
 * @throws Error when the operation succeeds.
 */
async function refusal(operation: Promise<unknown>): Promise<MoneyError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof MoneyError) {
      return error;
    }
    throw error;
  }
  throw new Error("the operation was not refused");
}

describe("the case's money state machine (plan 3.2): draft estimate, awaiting owner, held", () => {
  it("draft estimate --send--> awaiting owner: one transaction, one audit event carrying both states", async () => {
    const before = await lastEventId();
    const versionId = await sentEstimate();

    const [kase] = await db.select().from(patientCase).where(eq(patientCase.id, fixture.caseId));
    expect(kase!.moneyState).toBe("awaiting_owner");
    const sent = (await eventsSince(before)).filter(
      (event) => event.action !== "estimate.version_made",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      action: "estimate.sent",
      moneyStateBefore: "estimate_draft",
      moneyStateAfter: "awaiting_owner",
      amountPence: 77_300,
    });
    expect(sent[0]!.detail).toMatchObject({ versionId });
  });

  it("refuses to send a first estimate for a case that is not a draft", async () => {
    await sentEstimate();
    const second = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });

    const refused = await refusal(
      sendEstimate(db, { practiceId: fixture.practiceId, versionId: second.id, actor: "vet" }),
    );

    expect(refused.reason).toBe("wrong_state");
    const [still] = await db.select().from(patientCase).where(eq(patientCase.id, fixture.caseId));
    expect(still!.moneyState).toBe("awaiting_owner");
  });

  it("orders the hold for the top of the range (D3), the order mirroring the version's lines (3.3)", async () => {
    const versionId = await sentEstimate();

    const ordered = await orderHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      versionId,
    });

    expect(ordered.hold).toMatchObject({
      id: versionId,
      status: "ordered",
      amount: { pence: 77_300, currency: "GBP" },
      heldBeforePence: 0,
    });
    const [sent] = paypal.posts(/^\/v2\/checkout\/orders$/);
    const unit = (sent!.body as { purchase_units: Record<string, unknown>[] }).purchase_units[0]!;
    expect(unit.amount).toEqual({
      currency_code: "GBP",
      value: "773.00",
      breakdown: { item_total: { currency_code: "GBP", value: "773.00" } },
    });
    expect(unit.items).toEqual([
      {
        name: "General anaesthetic for dental work",
        sku: "GA-DENT",
        quantity: "1",
        unit_amount: { currency_code: "GBP", value: "320.00" },
      },
      {
        name: "Dental scale and polish",
        sku: "DEN-SP",
        quantity: "1",
        unit_amount: { currency_code: "GBP", value: "185.00" },
      },
      {
        name: "Removing up to two damaged teeth, if needed",
        sku: "DEN-EXT",
        quantity: "2",
        unit_amount: { currency_code: "GBP", value: "98.00" },
      },
      {
        name: "Pre-anaesthetic blood screen",
        sku: "LAB-PRE",
        quantity: "1",
        unit_amount: { currency_code: "GBP", value: "72.00" },
      },
    ]);
    expect(unit.custom_id).toBe(`${fixture.caseId}/${versionId}`);
    expect(unit.description).toBe("Biscuit's estimate from Money practice");
    expect(sent!.headers["paypal-request-id"]).toBe(
      paypalRequestId({ caseId: fixture.caseId, holdId: versionId, step: "order.create" }),
    );
    expect(ordered.approvalUrl).toBeNull();
  });

  it("answers a retried order with the same order: one PayPal order, one hold", async () => {
    const versionId = await sentEstimate();
    const request = { practiceId: fixture.practiceId, caseId: fixture.caseId, versionId };

    const first = await orderHold(deps(), request);
    const again = await orderHold(deps(), request);

    expect(again.hold.paypalOrderId).toBe(first.hold.paypalOrderId);
    expect(paypal.orders.size).toBe(1);
    expect(await db.select().from(hold).where(eq(hold.caseId, fixture.caseId))).toHaveLength(1);
  });

  it("refuses an order PayPal answers with another order than the hold's", async () => {
    const versionId = await sentEstimate();
    const request = { practiceId: fixture.practiceId, caseId: fixture.caseId, versionId };
    const first = await orderHold(deps(), request);
    const other = structuredClone(
      recordedAnswer("P1", "POST", /^\/v2\/checkout\/orders$/).responseBody,
    );
    paypal.inject({ method: "POST", path: /^\/v2\/checkout\/orders$/, status: 200, body: other });

    const refused = await refusal(orderHold(deps(), request));

    expect(refused.reason).toBe("wrong_state");
    const [kept] = await db.select().from(hold).where(eq(hold.id, versionId));
    expect(kept!.paypalOrderId).toBe(first.hold.paypalOrderId);
  });

  it("gives PayPal's checkout link when the order is made for a redirect", async () => {
    const versionId = await sentEstimate();

    const ordered = await orderHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      versionId,
      experience: {
        brandName: "Money practice",
        locale: "en-GB",
        returnUrl: "https://example.com/return",
        cancelUrl: "https://example.com/cancel",
      },
    });

    expect(ordered.approvalUrl).toMatch(
      /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/,
    );
  });

  it("refuses to order a version that is not the one awaiting the owner", async () => {
    await sentEstimate();
    const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });

    const refused = await refusal(
      orderHold(deps(), {
        practiceId: fixture.practiceId,
        caseId: fixture.caseId,
        versionId: draft.id,
      }),
    );

    expect(refused.reason).toBe("version_not_awaiting");
    expect(paypal.orders.size).toBe(0);
  });

  it("awaiting owner --owner authorises--> held: one audit event with the order and authorisation ids", async () => {
    const versionId = await sentEstimate();
    const { hold: ordered } = await orderHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      versionId,
    });
    paypal.approve(ordered.paypalOrderId);
    const before = await lastEventId();

    const held = await authoriseHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      holdId: ordered.id,
    });

    expect(held).toMatchObject({ status: "authorised", paymentKind: "paypal" });
    expect(held.authorizationId).toBe(paypal.orders.get(ordered.paypalOrderId)!.authorizationId);
    const events = await eventsSince(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "hold.authorised",
      actor: "owner",
      moneyStateBefore: "awaiting_owner",
      moneyStateAfter: "held",
      amountPence: 77_300,
      paypalOrderId: ordered.paypalOrderId,
      paypalAuthorizationId: held.authorizationId,
    });
    const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(money).toMatchObject({ state: "held", heldPence: 77_300, capturedPence: 0 });
    const [authorised] = paypal.posts(/\/authorize$/);
    expect(authorised!.headers["paypal-request-id"]).toBe(
      paypalRequestId({ caseId: fixture.caseId, holdId: versionId, step: "order.authorize" }),
    );
  });

  it("records a card hold as a card hold", async () => {
    const versionId = await sentEstimate();
    const { hold: ordered } = await orderHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      versionId,
    });
    paypal.approve(ordered.paypalOrderId, "card");

    const held = await authoriseHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      holdId: ordered.id,
    });

    expect(held.paymentKind).toBe("card");
  });

  it("leaves the case awaiting the owner when PayPal refuses the authorisation, with PayPal's debug id on the trail", async () => {
    const versionId = await sentEstimate();
    const { hold: ordered } = await orderHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      versionId,
    });

    const refused = await refusal(
      authoriseHold(deps(), {
        practiceId: fixture.practiceId,
        caseId: fixture.caseId,
        holdId: ordered.id,
      }),
    );

    expect(refused.reason).toBe("paypal_refused");
    expect(refused.issues).toContain("ORDER_NOT_APPROVED");
    const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(money.state).toBe("awaiting_owner");
    const event = (await eventsSince()).at(-1);
    expect(event).toMatchObject({ action: "hold.authorise_refused", paypalDebugId: "double422" });
  });

  it("authorising twice answers the hold as authorised, with no second authorisation", async () => {
    const versionId = await sentEstimate();
    const { hold: ordered } = await orderHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      versionId,
    });
    paypal.approve(ordered.paypalOrderId);
    const request = { practiceId: fixture.practiceId, caseId: fixture.caseId, holdId: ordered.id };

    const first = await authoriseHold(deps(), request);
    const again = await authoriseHold(deps(), request);

    expect(again.authorizationId).toBe(first.authorizationId);
    expect(paypal.authorizations.size).toBe(1);
  });
});

describe("withdrawn (plan 3.2: awaiting owner --estimate withdrawn--> withdrawn)", () => {
  it("withdraws an awaiting estimate, its order left unapproved and nothing voided", async () => {
    const versionId = await sentEstimate();
    const { hold: ordered } = await orderHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      versionId,
    });
    const before = await lastEventId();

    const state = await withdrawEstimate(db, {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      actor: "vet",
    });

    expect(state).toBe("withdrawn");
    expect(paypal.posts(/\/void$/)).toHaveLength(0);
    const [stored] = await db.select().from(hold).where(eq(hold.id, ordered.id));
    expect(stored!.status).toBe("withdrawn");
    const events = await eventsSince(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "estimate.withdrawn",
      moneyStateBefore: "awaiting_owner",
      moneyStateAfter: "withdrawn",
      paypalOrderId: ordered.paypalOrderId,
    });
  });

  it("refuses to withdraw a held estimate: a hold is released at discharge, by void", async () => {
    const versionId = await sentEstimate();
    const { hold: ordered } = await orderHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      versionId,
    });
    paypal.approve(ordered.paypalOrderId);
    await authoriseHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      holdId: ordered.id,
    });

    const refused = await refusal(
      withdrawEstimate(db, {
        practiceId: fixture.practiceId,
        caseId: fixture.caseId,
        actor: "vet",
      }),
    );

    expect(refused.reason).toBe("wrong_state");
  });

  it("voids at once an authorisation PayPal answers after the estimate was withdrawn", async () => {
    const versionId = await sentEstimate();
    const { hold: ordered } = await orderHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      versionId,
    });
    paypal.approve(ordered.paypalOrderId);
    // The owner's authorise is in flight at PayPal when the vet withdraws.
    paypal.inject({
      method: "POST",
      path: /\/authorize$/,
      status: 201,
      body: null,
      acts: true,
    });
    await refusal(
      authoriseHold(deps(), {
        practiceId: fixture.practiceId,
        caseId: fixture.caseId,
        holdId: ordered.id,
      }),
    );
    await withdrawEstimate(db, {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      actor: "vet",
    });

    const settled = await authoriseHold(deps(), {
      practiceId: fixture.practiceId,
      caseId: fixture.caseId,
      holdId: ordered.id,
    });

    expect(settled.status).toBe("voided");
    expect(paypal.posts(/\/void$/)).toHaveLength(1);
    const authorisationId = paypal.orders.get(ordered.paypalOrderId)!.authorizationId!;
    expect(paypal.authorizations.get(authorisationId)!.status).toBe("VOIDED");
    const [kase] = await db
      .select()
      .from(patientCase)
      .where(and(eq(patientCase.id, fixture.caseId)));
    expect(kase!.moneyState).toBe("withdrawn");
    const events = (await eventsSince()).map((event) => event.action);
    expect(events.slice(-1)).toEqual(["hold.voided"]);
  });
});
