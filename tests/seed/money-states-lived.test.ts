import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { AuditEventRecord } from "@/audit/writer";
import { auditEvent, capture, hold, patientCase, practice } from "@/db/schema";
import { importPriceList } from "@/estimate/price-list";
import { caseEstimateVersions, makeEstimateVersion } from "@/estimate/version";
import { reauthoriseHolds } from "@/jobs/reauthorise";
import { dischargeCase, signOffBill } from "@/money/discharge";
import { authoriseHold, orderHold, sendEstimate, withdrawEstimate } from "@/money/holds";
import { refundCaptured } from "@/money/refunds";

import { readSeedPriceList } from "../../seed/practice";
import { MONEY_STATE_CASES, type MoneyStateCase } from "../../seed/showcase/cases";
import { seedShowcase } from "../../seed/showcase";
import { connectTestDatabase } from "../support/database";
import { startPayPalDouble } from "../support/paypal-double";

const { db } = connectTestDatabase();
const double = startPayPalDouble();
const MINUTE_MS = 60 * 1000;

/** The events the money lifecycle writes, which the seed must write as U3 and U7 do. */
const MONEY_ACTIONS = /^(estimate\.(sent|withdrawn)|hold\.|bill\.|capture\.)/;

/**
 * An event as the comparison reads it: who did what, the states either side,
 * the amount, which PayPal ids it names, and its detail's keys (the seed's own
 * `seeded` aside).
 *
 * @param event - The event.
 * @returns Its shape.
 */
function shape(event: AuditEventRecord) {
  return {
    actor: event.actor,
    action: event.action,
    before: event.moneyStateBefore,
    after: event.moneyStateAfter,
    amountPence: event.amountPence,
    paypal: {
      order: event.paypalOrderId !== null,
      authorization: event.paypalAuthorizationId !== null,
      capture: event.paypalCaptureId !== null,
      refund: event.paypalRefundId !== null,
    },
    detail: Object.keys(event.detail as Record<string, unknown>)
      .filter((key) => key !== "seeded")
      .sort(),
  };
}

/**
 * A case's money events in the order they were written.
 *
 * @param caseId - The case.
 * @returns The events' shapes.
 */
async function moneyEvents(caseId: string) {
  const events = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.caseId, caseId))
    .orderBy(asc(auditEvent.id));
  return events.filter((event) => MONEY_ACTIONS.test(event.action)).map(shape);
}

/**
 * Lives a showcase case's story through U3's and U7's own functions against
 * the PayPal double, in a practice of its own priced from the seed's list.
 *
 * @param kase - The case.
 * @returns The lived case's id.
 */
async function live(kase: MoneyStateCase): Promise<string> {
  const { story } = kase;
  const [made] = await db
    .insert(practice)
    .values({ name: "Lived practice", kind: "judge" })
    .returning({ id: practice.id });
  const practiceId = made!.id;
  await importPriceList(db, {
    practiceId,
    actor: "system",
    sourceName: "seed/practice/price-list.csv",
    csv: readSeedPriceList(),
  });
  const [opened] = await db
    .insert(patientCase)
    .values({
      practiceId,
      patientName: kase.patientName,
      ownerName: kase.ownerName,
      procedure: kase.procedure,
      vetName: kase.vetName,
    })
    .returning({ id: patientCase.id });
  const fixture = { practiceId, caseId: opened!.id };
  const deps = { db, paypal: double.client() };

  const held = async (
    lines: MoneyStateCase["lines"],
    payment: "paypal" | "card" | null,
  ): Promise<void> => {
    const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: [...lines] });
    await sendEstimate(db, { practiceId, versionId: draft.id, actor: "vet" });
    if (story.orderedAt === undefined) {
      return;
    }
    const { hold: ordered } = await orderHold(deps, { ...fixture, versionId: draft.id });
    if (payment) {
      double.approve(ordered.paypalOrderId, payment);
      await authoriseHold(deps, { ...fixture, holdId: ordered.id });
    }
  };

  await held(kase.lines, story.authorised?.payment ?? null);
  if (story.withdrawnAt !== undefined) {
    await withdrawEstimate(db, { ...fixture, actor: "vet" });
  }
  if (story.honourPeriodFlaggedAfter !== undefined) {
    const [authorised] = await db
      .select({ at: hold.authorisedAt })
      .from(hold)
      .where(eq(hold.caseId, fixture.caseId));
    await reauthoriseHolds({
      ...deps,
      practiceId,
      now: new Date(authorised!.at!.getTime() + story.honourPeriodFlaggedAfter * MINUTE_MS),
    });
  }
  if (story.update) {
    await held([...kase.lines, ...kase.updateLines!], story.update.authorised.payment);
  }
  if (story.discharge) {
    const latest = (await caseEstimateVersions(db, practiceId, fixture.caseId)).at(-1)!;
    await signOffBill(db, {
      ...fixture,
      actor: "vet",
      lines: story.discharge.bill.map(({ code, quantity }) => ({
        estimateLineId: latest.lines.find((line) => line.code === code)!.id,
        quantity,
      })),
    });
    await dischargeCase(deps, fixture);
  }
  if (story.refund) {
    const [first] = await db
      .select({ id: capture.id })
      .from(capture)
      .innerJoin(hold, eq(hold.id, capture.holdId))
      .where(and(eq(hold.caseId, fixture.caseId), eq(hold.versionNumber, 1)));
    await refundCaptured(deps, {
      ...fixture,
      captureId: first!.id,
      amountPence: story.refund.pence,
      reason: story.refund.reason,
      actor: "vet",
    });
  }
  return fixture.caseId;
}

describe("the showcase's money stories, as U3's and U7's own functions tell them", () => {
  it.each(MONEY_STATE_CASES.map((kase) => [kase.patientName, kase] as const))(
    "%s's seeded events are the events living its story writes",
    async (_patient, kase) => {
      const seeded = await db.transaction(async (tx) => {
        const [made] = await tx
          .insert(practice)
          .values({ name: "Seeded practice", kind: "judge" })
          .returning({ id: practice.id });
        await importPriceList(tx, {
          practiceId: made!.id,
          actor: "system",
          sourceName: "seed/practice/price-list.csv",
          csv: readSeedPriceList(),
        });
        return seedShowcase(tx, made!.id);
      });
      const lived = await live(kase);

      expect(await moneyEvents(seeded.caseIds[kase.patientName]!)).toEqual(
        await moneyEvents(lived),
      );
      const [seededCase] = await db
        .select({ state: patientCase.moneyState })
        .from(patientCase)
        .where(eq(patientCase.id, seeded.caseIds[kase.patientName]!));
      const [livedCase] = await db
        .select({ state: patientCase.moneyState })
        .from(patientCase)
        .where(eq(patientCase.id, lived));
      expect(seededCase?.state).toBe(livedCase?.state);
    },
  );
});
