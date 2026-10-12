import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { appendAuditEvent, type AuditEventInput } from "@/audit/writer";
import type { Transaction } from "@/db/client";
import { estimateLine, estimateSource, estimateVersion, hold, patientCase } from "@/db/schema";
import { currentPriceList, type PriceListWithItems } from "@/estimate/price-list";
import { estimateLineInput, type EstimateLineInput } from "@/estimate/version";

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
    order: seededId(),
    authorisation: seededId(),
    reauthorisation: seededId(),
    updateOrder: seededId(),
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

  const estimate = await seedVersion(tx, {
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
  await event(
    sent(estimate, money.currency, "estimate_draft", "awaiting_owner"),
    story(0, 8, 19, 30),
  );

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

  const update = await seedVersion(tx, {
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
  await event(sent(update, money.currency, "held", "update_awaiting_owner"), story(0, 10, 34, 30));
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

/** A version the seed wrote, as its events name it. */
interface SeededVersion {
  readonly id: string;
  readonly number: number;
  readonly currency: PriceListWithItems["currencyCode"];
  readonly lineCount: number;
  readonly priceListId: string;
  readonly lowPence: number;
  readonly highPence: number;
}

/**
 * Writes one version as a draft with its lines and its source, then sends it,
 * as U2 does: the database checks the sent totals against the lines.
 *
 * @param tx - The transaction.
 * @param write - The version's practice, case, list, number, lines, source and times.
 * @param write.practiceId - The practice.
 * @param write.caseId - The case.
 * @param write.list - The price list it is priced from.
 * @param write.number - Its number.
 * @param write.lines - Its lines.
 * @param write.source - The words it was drafted from.
 * @param write.source.kind - Notes or a finding.
 * @param write.source.text - The words.
 * @param write.source.explanation - The owner's explanation of an update.
 * @param write.madeAt - When it was made.
 * @param write.sentAt - When it was sent.
 * @returns The version.
 */
async function seedVersion(
  tx: Transaction,
  write: {
    practiceId: string;
    caseId: string;
    list: PriceListWithItems;
    number: number;
    lines: readonly EstimateLineInput[];
    source: { kind: "notes" | "finding"; text: string; explanation: string | null };
    madeAt: Date;
    sentAt: Date;
  },
): Promise<SeededVersion> {
  const priced = write.lines.map((given) => {
    const line = estimateLineInput.parse(given);
    const item = write.list.items.get(line.code);
    if (!item) {
      throw new Error(`the showcase case's ${line.code} is not on the practice's price list`);
    }
    return { line, item };
  });
  const [version] = await tx
    .insert(estimateVersion)
    .values({
      practiceId: write.practiceId,
      caseId: write.caseId,
      priceListId: write.list.id,
      number: write.number,
      createdAt: write.madeAt,
    })
    .returning({ id: estimateVersion.id });
  const versionId = version!.id;
  await tx.insert(estimateLine).values(
    priced.map(({ line, item }, at) => ({
      versionId,
      priceListId: write.list.id,
      position: at + 1,
      priceListItemId: item.id,
      unitPricePence: item.unitPricePence,
      quantityLow: line.quantityLow,
      quantityHigh: line.quantityHigh,
      dependsOn: line.dependsOn ?? null,
      notesSpan: line.notesSpan ?? null,
      ownerWording: line.ownerWording ?? null,
    })),
  );
  await tx.insert(estimateSource).values({
    versionId,
    practiceId: write.practiceId,
    caseId: write.caseId,
    kind: write.source.kind,
    text: write.source.text,
    explanation: write.source.explanation,
    createdAt: write.madeAt,
    updatedAt: write.madeAt,
  });
  const lowPence = priced.reduce(
    (sum, { line, item }) => sum + item.unitPricePence * line.quantityLow,
    0,
  );
  const highPence = priced.reduce(
    (sum, { line, item }) => sum + item.unitPricePence * line.quantityHigh,
    0,
  );
  await tx
    .update(estimateVersion)
    .set({ sentAt: write.sentAt, totalLowPence: lowPence, totalHighPence: highPence })
    .where(eq(estimateVersion.id, versionId));
  return {
    id: versionId,
    number: write.number,
    currency: write.list.currencyCode,
    lineCount: priced.length,
    priceListId: write.list.id,
    lowPence,
    highPence,
  };
}

/**
 * `estimate.version_made`, as U2 writes it.
 *
 * @param version - The version.
 * @returns The event.
 */
function versionMade(version: SeededVersion): Omit<AuditEventInput, "practiceId" | "caseId"> {
  return {
    actor: "vet",
    action: "estimate.version_made",
    detail: {
      versionId: version.id,
      number: version.number,
      priceListId: version.priceListId,
      lineCount: version.lineCount,
      lowPence: version.lowPence,
      highPence: version.highPence,
    },
  };
}

/**
 * `estimate.approved`, the vet's approval with the vet's name, as U5 writes it.
 *
 * @param version - The version.
 * @param vetName - The vet.
 * @returns The event.
 */
function approved(
  version: SeededVersion,
  vetName: string,
): Omit<AuditEventInput, "practiceId" | "caseId"> {
  return {
    actor: "vet",
    action: "estimate.approved",
    detail: {
      versionId: version.id,
      number: version.number,
      vetName,
      lowPence: version.lowPence,
      highPence: version.highPence,
      lineCount: version.lineCount,
    },
  };
}

/**
 * `estimate.sent` with the states before and after, as U3 writes it.
 *
 * @param version - The version.
 * @param currency - Its currency.
 * @param before - The case's state before.
 * @param after - The case's state after.
 * @returns The event.
 */
function sent(
  version: SeededVersion,
  currency: SeededVersion["currency"],
  before: "estimate_draft" | "held",
  after: "awaiting_owner" | "update_awaiting_owner",
): Omit<AuditEventInput, "practiceId" | "caseId"> {
  return {
    actor: "vet",
    action: "estimate.sent",
    moneyStateBefore: before,
    moneyStateAfter: after,
    amount: { pence: version.highPence, currency },
    detail: {
      versionId: version.id,
      number: version.number,
      lowPence: version.lowPence,
      highPence: version.highPence,
    },
  };
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

/**
 * A PayPal-shaped id that says it is seeded: `SEEDED` and ten upper-case hex digits.
 *
 * @returns The id.
 */
function seededId(): string {
  return `SEEDED${randomBytes(5).toString("hex").toUpperCase()}`;
}
