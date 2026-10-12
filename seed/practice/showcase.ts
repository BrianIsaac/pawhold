import { appendAuditEvent, type AuditEventInput } from "@/audit/writer";
import type { Transaction } from "@/db/client";
import { hold, patientCase } from "@/db/schema";
import { currentPriceList } from "@/estimate/price-list";
import type { EstimateLineInput } from "@/estimate/version";
import { seededPayPalId } from "@/paypal/seeded";

import { approved, sent, versionMade, writeSentVersion } from "../versions";

/**
 * The showcase case every judge's practice opens with (U5's brief; U3's "To
 * U9"): the vet's notes and a sent estimate, the owner's PayPal hold, an
 * update the owner declined, and the hold reauthorised on day 4, so the
 * practice's screens and the timeline have every kind of row to show on the
 * first visit. Its history is seeded, not lived: every event says so (D16),
 * and its PayPal ids begin `SEEDED` so nothing mistakes them for PayPal's.
 * The words are written for this entry; the lines are what the estimate
 * agent's guardrails would let through (a test holds them to it).
 */
export const SHOWCASE_CASE = {
  patientName: "Bramble",
  ownerName: "Nadia Haddad",
  procedure: "Dental under GA",
  vetName: "Rowan Hale",
  notes:
    "9yo MN JRT, 8.2 kg. Heavy calculus, gingivitis, halitosis. Plan: pre-op bloods, GA, dental charting, dental scale and polish, dental radiographs, probable two extractions upper PM. Pain relief to go home.",
  estimateLines: [
    {
      code: "LAB-PRE",
      quantityLow: 1,
      quantityHigh: 1,
      notesSpan: "pre-op bloods",
      ownerWording: "Blood test before the anaesthetic",
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
      ownerWording: "Checking and charting every tooth",
    },
    {
      code: "DEN-SP",
      quantityLow: 1,
      quantityHigh: 1,
      notesSpan: "dental scale and polish",
      ownerWording: "Scale and polish",
    },
    {
      code: "IMG-XR-DENT",
      quantityLow: 1,
      quantityHigh: 1,
      notesSpan: "dental radiographs",
      ownerWording: "X-rays of the teeth",
    },
    {
      code: "DEN-EXT-SG",
      quantityLow: 0,
      quantityHigh: 2,
      dependsOn: "the X-rays show the teeth need to come out",
      notesSpan: "probable two extractions upper PM",
      ownerWording: "Removing up to two damaged teeth, if needed",
    },
    {
      code: "MED-NSAID-ORAL",
      quantityLow: 1,
      quantityHigh: 1,
      notesSpan: "Pain relief to go home",
      ownerWording: "Pain relief to take home",
    },
  ],
  finding:
    "Radiographs show a fractured upper left canine with the root exposed. Recommend surgical extraction of the canine, an extra 30 minutes under GA. Antibiotics to go home.",
  updateLines: [
    {
      code: "DEN-EXT-SG",
      quantityLow: 1,
      quantityHigh: 1,
      notesSpan: "surgical extraction of the canine",
      ownerWording: "Removing the broken canine tooth",
    },
    {
      code: "GA-EXTRA",
      quantityLow: 2,
      quantityHigh: 2,
      notesSpan: "an extra 30 minutes under GA",
      ownerWording: "More time under anaesthetic",
    },
    {
      code: "MED-ANTIB-TAB",
      quantityLow: 1,
      quantityHigh: 1,
      notesSpan: "Antibiotics to go home",
      ownerWording: "Antibiotic tablets to take home",
    },
  ],
  explanation:
    "Rowan found that one of Bramble's upper canine teeth is broken, with its root exposed. Rowan recommends removing it surgically, which needs about 30 more minutes under anaesthetic, and antibiotic tablets to take home.",
} as const satisfies {
  estimateLines: readonly EstimateLineInput[];
  updateLines: readonly EstimateLineInput[];
} & Record<string, unknown>;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Seeds the showcase case into a new practice, inside the transaction making
 * it, after its price list is imported. Rows are written as U2's and U3's
 * functions write them and the database checks them as it checks theirs;
 * events are back-dated to the story's times, which only a seeded event may be.
 *
 * @param tx - The transaction making the practice.
 * @param practiceId - The practice.
 * @param now - The clock: the story starts five days before it and ends the day before.
 * @returns The case's id.
 * @throws Error when the practice has no price list or a line's item is not on it.
 */
export async function seedShowcaseCase(
  tx: Transaction,
  practiceId: string,
  now: Date = new Date(),
): Promise<string> {
  const list = await currentPriceList(tx, practiceId);
  if (!list) {
    throw new Error("the showcase case is priced from the practice's list: import it first");
  }
  const story = storyClock(now);
  const ids = {
    order: seededPayPalId(),
    authorisation: seededPayPalId(),
    reauthorisation: seededPayPalId(),
    updateOrder: seededPayPalId(),
  };
  const kase = SHOWCASE_CASE;
  const event = (input: Omit<AuditEventInput, "practiceId" | "caseId">, at: Date) =>
    appendAuditEvent(
      tx,
      { practiceId, caseId, ...input, detail: { ...input.detail, seeded: true } },
      { occurredAt: at },
    );

  const [made] = await tx
    .insert(patientCase)
    .values({
      practiceId,
      patientName: kase.patientName,
      ownerName: kase.ownerName,
      procedure: kase.procedure,
      vetName: kase.vetName,
      moneyState: "update_declined",
      currencyCode: list.currencyCode,
      createdAt: story(0, 8, 5),
      updatedAt: story(4, 8, 45),
    })
    .returning({ id: patientCase.id });
  const caseId = made!.id;
  await event(
    {
      actor: "vet",
      action: "case.opened",
      moneyStateAfter: "estimate_draft",
      detail: {
        patientName: kase.patientName,
        ownerName: kase.ownerName,
        procedure: kase.procedure,
        vetName: kase.vetName,
      },
    },
    story(0, 8, 5),
  );

  const estimate = await writeSentVersion(tx, {
    practiceId,
    caseId,
    list,
    number: 1,
    lines: kase.estimateLines,
    source: { kind: "notes", text: kase.notes, explanation: null },
    madeAt: story(0, 8, 12),
    sentAt: story(0, 8, 19, 30),
  });
  const money = { currency: estimate.currency };
  await event(versionMade(estimate), story(0, 8, 12));
  await event(approved(estimate, kase.vetName), story(0, 8, 19));
  await event(sent(estimate, "estimate_draft", "awaiting_owner"), story(0, 8, 19, 30));

  const authorisedAt = story(0, 8, 43);
  const reauthorisedAt = story(4, 8, 45);
  await tx.insert(hold).values({
    id: estimate.id,
    practiceId,
    caseId,
    versionNumber: 1,
    versionHighPence: estimate.highPence,
    heldBeforePence: 0,
    amountPence: estimate.highPence,
    currencyCode: money.currency,
    status: "authorised",
    paypalOrderId: ids.order,
    authorizationId: ids.reauthorisation,
    originalAuthorizationId: ids.authorisation,
    paymentKind: "paypal",
    authorisedAt,
    expiresAt: new Date(authorisedAt.getTime() + 29 * DAY_MS),
    reauthorisedAt,
    createdAt: story(0, 8, 41),
    updatedAt: reauthorisedAt,
  });
  await event(
    {
      actor: "owner",
      action: "hold.ordered",
      amount: { pence: estimate.highPence, currency: money.currency },
      paypal: { orderId: ids.order },
      detail: { holdId: estimate.id, versionNumber: 1, heldBeforePence: 0 },
    },
    story(0, 8, 41),
  );
  await event(
    {
      actor: "owner",
      action: "hold.authorised",
      moneyStateBefore: "awaiting_owner",
      moneyStateAfter: "held",
      amount: { pence: estimate.highPence, currency: money.currency },
      paypal: { orderId: ids.order, authorizationId: ids.authorisation },
      detail: {
        holdId: estimate.id,
        versionNumber: 1,
        paymentKind: "paypal",
        expiresAt: new Date(authorisedAt.getTime() + 29 * DAY_MS).toISOString(),
      },
    },
    authorisedAt,
  );

  const update = await writeSentVersion(tx, {
    practiceId,
    caseId,
    list,
    number: 2,
    lines: [...kase.estimateLines, ...kase.updateLines],
    source: { kind: "finding", text: kase.finding, explanation: kase.explanation },
    madeAt: story(0, 10, 30),
    sentAt: story(0, 10, 34, 30),
  });
  const increasePence = update.highPence - estimate.highPence;
  await event(versionMade(update), story(0, 10, 30));
  await event(approved(update, kase.vetName), story(0, 10, 34));
  await event(sent(update, "held", "update_awaiting_owner"), story(0, 10, 34, 30));
  await tx.insert(hold).values({
    id: update.id,
    practiceId,
    caseId,
    versionNumber: 2,
    versionHighPence: update.highPence,
    heldBeforePence: estimate.highPence,
    amountPence: increasePence,
    currencyCode: money.currency,
    status: "declined",
    paypalOrderId: ids.updateOrder,
    closedAt: story(0, 11, 5),
    createdAt: story(0, 10, 52),
    updatedAt: story(0, 11, 5),
  });
  await event(
    {
      actor: "owner",
      action: "hold.ordered",
      amount: { pence: increasePence, currency: money.currency },
      paypal: { orderId: ids.updateOrder },
      detail: { holdId: update.id, versionNumber: 2, heldBeforePence: estimate.highPence },
    },
    story(0, 10, 52),
  );
  await event(
    {
      actor: "owner",
      action: "estimate.update_declined",
      moneyStateBefore: "update_awaiting_owner",
      moneyStateAfter: "update_declined",
      paypal: { orderId: ids.updateOrder },
      detail: { versionId: update.id, holdId: update.id },
    },
    story(0, 11, 5),
  );
  await event(
    {
      actor: "system",
      action: "hold.reauthorised",
      amount: { pence: estimate.highPence, currency: money.currency },
      paypal: { orderId: ids.order, authorizationId: ids.reauthorisation },
      detail: {
        holdId: estimate.id,
        previousAuthorizationId: ids.authorisation,
        originalAuthorizationId: ids.authorisation,
        authorisedAt: authorisedAt.toISOString(),
        newStatus: "CREATED",
      },
    },
    reauthorisedAt,
  );
  return caseId;
}

/**
 * The story's clock: a time on one of its days, the first five days before
 * now (UTC), so its last event, on day 4, is always in the past.
 *
 * @param now - The clock.
 * @returns A function from (day, hour, minute, second) to the instant.
 */
function storyClock(
  now: Date,
): (day: number, hour: number, minute: number, second?: number) => Date {
  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 5 * DAY_MS;
  return (day, hour, minute, second = 0) =>
    new Date(first + day * DAY_MS + hour * 60 * MINUTE_MS + minute * MINUTE_MS + second * 1000);
}
