import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { auditEvent, hold } from "@/db/schema";
import { makeEstimateVersion } from "@/estimate/version";
import { MoneyError } from "@/money/errors";
import {
  authoriseHold,
  declineUpdate,
  orderHold,
  sendEstimate,
  withdrawEstimate,
} from "@/money/holds";
import { caseMoney, updateIncrease } from "@/money/view";

import { connectTestDatabase } from "../support/database";
import {
  DENTAL_LINES,
  DENTAL_UPDATE_LINES,
  makeDentalCase,
  type MoneyFixture,
} from "../support/money";
import { startPayPalDouble } from "../support/paypal-double";

const { db } = connectTestDatabase();
const paypal = startPayPalDouble();

let fixture: MoneyFixture;

/**
 * The money lifecycle's dependencies, on the double.
 *
 * @returns The database and the PayPal client.
 */
function deps() {
  return { db, paypal: paypal.client() };
}

/**
 * Sends a version, has the owner order and approve its hold, and authorises it.
 *
 * @param lines - The version's lines.
 * @returns The version's id.
 */
async function sendAndHold(lines = DENTAL_LINES): Promise<string> {
  const versionId = await send(lines);
  const { hold: ordered } = await orderHold(deps(), { ...fixture, versionId });
  paypal.approve(ordered.paypalOrderId);
  await authoriseHold(deps(), { ...fixture, holdId: ordered.id });
  return versionId;
}

/**
 * Drafts and sends a version.
 *
 * @param lines - The version's lines.
 * @returns The version's id.
 */
async function send(lines = DENTAL_UPDATE_LINES): Promise<string> {
  const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines });
  await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
  return draft.id;
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

beforeEach(async () => {
  fixture = await makeDentalCase(db);
  await sendAndHold();
});

describe("the update (plan 3.2: held --vet adds work--> update awaiting owner --owner authorises--> held, two holds)", () => {
  it("moves the held case to awaiting the owner's answer on the update", async () => {
    await send();

    expect((await caseMoney(db, fixture.practiceId, fixture.caseId)).state).toBe(
      "update_awaiting_owner",
    );
  });

  it("computes the increase over the held total from the holds (U2's rides-to-U3)", async () => {
    const updateId = await send();

    expect(await updateIncrease(db, fixture.practiceId, updateId)).toEqual({
      heldPence: 77_300,
      versionHighPence: 92_800,
      increasePence: 15_500,
    });
  });

  it("holds the increase as a second hold: the order is the whole version less what is held", async () => {
    const updateId = await send();

    const { hold: ordered } = await orderHold(deps(), { ...fixture, versionId: updateId });

    expect(ordered).toMatchObject({
      amount: { pence: 15_500, currency: "GBP" },
      heldBeforePence: 77_300,
    });
    const sent = paypal.posts(/^\/v2\/checkout\/orders$/).at(-1)!;
    const unit = (sent.body as { purchase_units: Record<string, unknown>[] }).purchase_units[0]!;
    expect(unit.amount).toEqual({
      currency_code: "GBP",
      value: "155.00",
      breakdown: {
        item_total: { currency_code: "GBP", value: "928.00" },
        discount: { currency_code: "GBP", value: "773.00" },
      },
    });
    expect(unit.description).toBe("Biscuit's updated estimate from Money practice");
  });

  it("owner authorises the update: held, with two holds, both standing (P7: one buyer, two orders)", async () => {
    const updateId = await send();
    const { hold: ordered } = await orderHold(deps(), { ...fixture, versionId: updateId });
    paypal.approve(ordered.paypalOrderId);

    await authoriseHold(deps(), { ...fixture, holdId: ordered.id });

    const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(money.state).toBe("held");
    expect(money.holds.map((one) => [one.versionNumber, one.status, one.amount.pence])).toEqual([
      [1, "authorised", 77_300],
      [2, "authorised", 15_500],
    ]);
    expect(money.heldPence).toBe(92_800);
    expect(paypal.posts(/\/void$/)).toHaveLength(0);
  });

  it("refuses an update that adds nothing over what is held: there is nothing to authorise", async () => {
    const draft = await makeEstimateVersion(db, {
      ...fixture,
      actor: "vet",
      lines: DENTAL_LINES.slice(0, 2),
    });

    const refused = await refusal(
      sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" }),
    );

    expect(refused.reason).toBe("no_increase");
    expect((await caseMoney(db, fixture.practiceId, fixture.caseId)).state).toBe("held");
  });
});

describe("held, update declined (scope frozen at what is held)", () => {
  it("owner declines: the case is held at its first estimate, the update's order never authorised", async () => {
    const updateId = await send();
    const { hold: ordered } = await orderHold(deps(), { ...fixture, versionId: updateId });

    const state = await declineUpdate(db, { ...fixture, actor: "owner" });

    expect(state).toBe("update_declined");
    const money = await caseMoney(db, fixture.practiceId, fixture.caseId);
    expect(money.heldPence).toBe(77_300);
    expect(money.holds.map((one) => one.status)).toEqual(["authorised", "declined"]);
    const [declined] = await db.select().from(hold).where(eq(hold.id, ordered.id));
    expect(declined!.closedAt).not.toBeNull();
    const events = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.caseId, fixture.caseId))
      .orderBy(asc(auditEvent.id));
    expect(events.at(-1)).toMatchObject({
      action: "estimate.update_declined",
      actor: "owner",
      moneyStateBefore: "update_awaiting_owner",
      moneyStateAfter: "update_declined",
      paypalOrderId: ordered.paypalOrderId,
    });
  });

  it("refuses to order the declined update afterwards", async () => {
    const updateId = await send();
    await declineUpdate(db, { ...fixture, actor: "owner" });

    const refused = await refusal(orderHold(deps(), { ...fixture, versionId: updateId }));

    expect(refused.reason).toBe("wrong_state");
  });

  it("a declined case can be asked again with a further update", async () => {
    await send();
    await declineUpdate(db, { ...fixture, actor: "owner" });
    const versions = await makeEstimateVersion(db, {
      ...fixture,
      actor: "vet",
      lines: [...DENTAL_UPDATE_LINES.slice(0, 5)],
    });

    await sendEstimate(db, {
      practiceId: fixture.practiceId,
      versionId: versions.id,
      actor: "vet",
    });

    expect((await caseMoney(db, fixture.practiceId, fixture.caseId)).state).toBe(
      "update_awaiting_owner",
    );
    expect(await updateIncrease(db, fixture.practiceId, versions.id)).toMatchObject({
      heldPence: 77_300,
      increasePence: 12_000,
    });
  });

  it("refuses a decline when no update awaits the owner (a first estimate is withdrawn, not declined)", async () => {
    const refused = await refusal(declineUpdate(db, { ...fixture, actor: "owner" }));

    expect(refused.reason).toBe("wrong_state");
  });

  it("an update withdrawn by the vet returns the case to where it was sent from", async () => {
    await send();
    await declineUpdate(db, { ...fixture, actor: "owner" });
    const again = await makeEstimateVersion(db, {
      ...fixture,
      actor: "vet",
      lines: DENTAL_UPDATE_LINES,
    });
    await sendEstimate(db, { practiceId: fixture.practiceId, versionId: again.id, actor: "vet" });

    expect(await withdrawEstimate(db, { ...fixture, actor: "vet" })).toBe("update_declined");

    const plain = await makeDentalCase(db, "Second practice");
    fixture = plain;
    await sendAndHold();
    await send();
    expect(await withdrawEstimate(db, { ...fixture, actor: "vet" })).toBe("held");
  });
});
