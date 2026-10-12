import { eq } from "drizzle-orm";

import { appendAuditEvent, type AuditEventInput } from "@/audit/writer";
import type { Transaction } from "@/db/client";
import {
  allocation,
  bill,
  billLine,
  capture,
  estimateLine,
  estimateSource,
  estimateVersion,
  hold,
  patientCase,
  refund,
} from "@/db/schema";
import type { PriceListWithItems } from "@/estimate/price-list";
import { estimateLineInput, type EstimateLineInput } from "@/estimate/version";
import { allocateBill, approvalsByHold } from "@/money/allocation";
import type { MoneyState } from "@/money/state";
import { seededPayPalId } from "@/paypal/seeded";

import type { MoneyStateCase, SeededPayment } from "./cases";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** PayPal's authorisation period: "Valid for 29 days" (U3's `AUTHORISATION_PERIOD_MS`). */
const AUTHORISATION_PERIOD_MS = 29 * DAY_MS;

/**
 * How long after each PayPal step its webhook is shown to have confirmed it:
 * P8 and P9 saw lags of about 20 s.
 */
const WEBHOOK_LAG_MS = 18 * SECOND_MS;

/** The reason U3's hourly rule writes when it flags a card hold. */
const CARD_FLAG_REASON =
  "a card hold is never reauthorised: PayPal documents reauthorisation for PayPal accounts only";

/** One line of a seeded version, as the bill and the allocation need it. */
interface SeededLine {
  readonly id: string;
  readonly code: string;
  readonly unitPricePence: number;
  readonly highPence: number;
}

/** A version the seed wrote, as its events and its hold name it. */
interface SeededVersion {
  readonly id: string;
  readonly number: number;
  readonly priceListId: string;
  readonly lowPence: number;
  readonly highPence: number;
  readonly lines: readonly SeededLine[];
}

/** A hold the seed wrote, as the discharge reads it. */
interface SeededHold {
  readonly id: string;
  readonly version: SeededVersion;
  readonly amountPence: number;
  readonly orderId: string;
  readonly authorizationId: string;
  readonly expiresAt: Date;
}

/** What one case's story left behind. */
export interface WrittenCase {
  readonly caseId: string;
  readonly state: MoneyState;
}

/**
 * Writes one of the showcase's cases as its money story has it, inside the
 * transaction making the practice: rows the database checks as it checks
 * U2's, U3's and U7's (the bill allocated by U3's own allocator, so the
 * deferred money rules hold it to the same sums the lifecycle would), every
 * event back-dated to the story and said to be seeded (D16), every PayPal id
 * beginning `SEEDED`, so nothing ever asks PayPal about them.
 *
 * @param tx - The transaction making the practice.
 * @param write - The practice, its price list, the case and when its story starts.
 * @param write.practiceId - The practice.
 * @param write.list - The price list its lines are priced from.
 * @param write.kase - The case.
 * @param write.startsAt - When its story starts.
 * @returns The case's id and the money state its story leaves it in.
 * @throws Error when a line's item is not on the list, or the story is not one plan 3.2 draws.
 */
export async function writeMoneyStateCase(
  tx: Transaction,
  write: { practiceId: string; list: PriceListWithItems; kase: MoneyStateCase; startsAt: Date },
): Promise<WrittenCase> {
  const { practiceId, list, kase } = write;
  const { story } = kase;
  const at = (minutes: number, seconds = 0): Date =>
    new Date(write.startsAt.getTime() + minutes * MINUTE_MS + seconds * SECOND_MS);
  const currency = list.currencyCode;

  const [made] = await tx
    .insert(patientCase)
    .values({
      practiceId,
      patientName: kase.patientName,
      ownerName: kase.ownerName,
      procedure: kase.procedure,
      vetName: kase.vetName,
      currencyCode: currency,
      createdAt: at(0),
      updatedAt: at(0),
    })
    .returning({ id: patientCase.id });
  const caseId = made!.id;
  let last = at(0);
  const event = async (input: Omit<AuditEventInput, "practiceId" | "caseId">, when: Date) => {
    last = when;
    await appendAuditEvent(
      tx,
      { practiceId, caseId, ...input, detail: { ...input.detail, seeded: true } },
      { occurredAt: when },
    );
  };
  const money = (pence: number) => ({ pence, currency });

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
    at(0),
  );

  const estimate = await writeSentVersion(tx, {
    practiceId,
    caseId,
    list,
    number: 1,
    lines: kase.lines,
    source: { kind: "notes", text: kase.notes, explanation: null },
    madeAt: at(story.sentAt - 7),
    sentAt: at(story.sentAt),
  });
  await event(versionMade(estimate), at(story.sentAt - 7));
  await event(approved(estimate, kase.vetName), at(story.sentAt, -30));
  await event(sent(estimate, currency, "estimate_draft", "awaiting_owner"), at(story.sentAt));
  let state: MoneyState = "awaiting_owner";

  if (story.orderedAt === undefined) {
    if (story.authorised || story.withdrawnAt !== undefined) {
      throw new Error(`${kase.patientName}'s owner authorises through PayPal's checkout first`);
    }
    return settle(tx, caseId, state, last);
  }
  const firstOrder = seededPayPalId();
  await tx.insert(hold).values({
    id: estimate.id,
    practiceId,
    caseId,
    versionNumber: 1,
    versionHighPence: estimate.highPence,
    heldBeforePence: 0,
    amountPence: estimate.highPence,
    currencyCode: currency,
    paypalOrderId: firstOrder,
    createdAt: at(story.orderedAt),
    updatedAt: at(story.orderedAt),
  });
  await event(
    ordered(estimate.id, 1, estimate.highPence, 0, firstOrder, currency),
    at(story.orderedAt),
  );

  if (story.withdrawnAt !== undefined) {
    await tx
      .update(hold)
      .set({
        status: "withdrawn",
        closedAt: at(story.withdrawnAt),
        updatedAt: at(story.withdrawnAt),
      })
      .where(eq(hold.id, estimate.id));
    await event(
      {
        actor: "vet",
        action: "estimate.withdrawn",
        moneyStateBefore: state,
        moneyStateAfter: "withdrawn",
        paypal: { orderId: firstOrder },
        detail: { versionId: estimate.id, holdId: estimate.id },
      },
      at(story.withdrawnAt),
    );
    return settle(tx, caseId, "withdrawn", last);
  }
  if (!story.authorised) {
    return settle(tx, caseId, state, last);
  }

  const first = await authorise(tx, {
    holdId: estimate.id,
    version: estimate,
    amountPence: estimate.highPence,
    orderId: firstOrder,
    payment: story.authorised.payment,
    authorisedAt: at(story.authorised.at),
  });
  await event(
    authorised(first, 1, story.authorised.payment, currency, state, "held"),
    at(story.authorised.at),
  );
  state = "held";
  const holds: SeededHold[] = [first];

  if (story.honourPeriodFlaggedAfter !== undefined) {
    if (story.authorised.payment !== "card") {
      throw new Error("the hourly rule flags a card hold; a PayPal hold is reauthorised first");
    }
    const flaggedAt = at(story.authorised.at + story.honourPeriodFlaggedAfter);
    await tx
      .update(hold)
      .set({ honourPeriodFlaggedAt: flaggedAt, updatedAt: flaggedAt })
      .where(eq(hold.id, first.id));
    await event(
      {
        actor: "system",
        action: "hold.honour_period_over",
        amount: money(first.amountPence),
        paypal: { orderId: first.orderId, authorizationId: first.authorizationId },
        detail: {
          holdId: first.id,
          paymentKind: story.authorised.payment,
          reason: CARD_FLAG_REASON,
          honourPeriodFrom: at(story.authorised.at).toISOString(),
        },
      },
      flaggedAt,
    );
  }

  if (story.update) {
    if (!kase.finding || !kase.updateLines) {
      throw new Error(`${kase.patientName}'s update needs its finding and its lines`);
    }
    const update = await writeSentVersion(tx, {
      practiceId,
      caseId,
      list,
      number: 2,
      lines: [...kase.lines, ...kase.updateLines],
      source: { kind: "finding", text: kase.finding, explanation: kase.explanation ?? null },
      madeAt: at(story.update.sentAt - 6),
      sentAt: at(story.update.sentAt),
    });
    await event(versionMade(update), at(story.update.sentAt - 6));
    await event(approved(update, kase.vetName), at(story.update.sentAt, -30));
    await event(sent(update, currency, "held", "update_awaiting_owner"), at(story.update.sentAt));
    state = "update_awaiting_owner";
    const increasePence = update.highPence - estimate.highPence;
    const updateOrder = seededPayPalId();
    const orderedAt = at(story.update.authorised.at - 2);
    await tx.insert(hold).values({
      id: update.id,
      practiceId,
      caseId,
      versionNumber: 2,
      versionHighPence: update.highPence,
      heldBeforePence: estimate.highPence,
      amountPence: increasePence,
      currencyCode: currency,
      paypalOrderId: updateOrder,
      createdAt: orderedAt,
      updatedAt: orderedAt,
    });
    await event(
      ordered(update.id, 2, increasePence, estimate.highPence, updateOrder, currency),
      orderedAt,
    );
    const second = await authorise(tx, {
      holdId: update.id,
      version: update,
      amountPence: increasePence,
      orderId: updateOrder,
      payment: story.update.authorised.payment,
      authorisedAt: at(story.update.authorised.at),
    });
    await event(
      authorised(second, 2, story.update.authorised.payment, currency, state, "held"),
      at(story.update.authorised.at),
    );
    state = "held";
    holds.push(second);
  }

  if (!story.discharge) {
    if (story.refund) {
      throw new Error("a refund comes after a discharge");
    }
    return settle(tx, caseId, state, last);
  }
  const discharged = await discharge(tx, {
    practiceId,
    caseId,
    holds,
    lines: story.discharge.bill,
    signedOffAt: at(story.discharge.at),
    state,
    event,
    money,
  });
  state = discharged.state;

  if (story.refund) {
    const refundedAt = at(story.refund.at);
    const taken = discharged.captures[0];
    if (!taken) {
      throw new Error(`${kase.patientName}'s refund needs a capture from the first hold`);
    }
    const refundId = seededPayPalId();
    const [row] = await tx
      .insert(refund)
      .values({
        captureId: taken.id,
        sequence: 1,
        amountPence: story.refund.pence,
        currencyCode: currency,
        reason: story.refund.reason,
        requestedBy: "vet",
        status: "completed",
        paypalRefundId: refundId,
        refundedAt: new Date(refundedAt.getTime() + 4 * SECOND_MS),
        confirmedAt: new Date(refundedAt.getTime() + WEBHOOK_LAG_MS),
        createdAt: refundedAt,
        updatedAt: refundedAt,
      })
      .returning({ id: refund.id });
    await tx
      .update(capture)
      .set({
        status: story.refund.pence >= taken.amountPence ? "refunded" : "partially_refunded",
        updatedAt: refundedAt,
      })
      .where(eq(capture.id, taken.id));
    const paypal = {
      orderId: taken.hold.orderId,
      authorizationId: taken.hold.authorizationId,
      captureId: taken.paypalCaptureId,
    };
    await event(
      {
        actor: "vet",
        action: "capture.refund_requested",
        amount: money(story.refund.pence),
        paypal,
        detail: {
          refundId: row!.id,
          captureId: taken.id,
          reason: story.refund.reason,
          leftBeforePence: taken.amountPence,
        },
      },
      refundedAt,
    );
    await event(
      {
        actor: "vet",
        action: "capture.refunded",
        moneyStateBefore: state,
        moneyStateAfter: "refunded",
        amount: money(story.refund.pence),
        paypal: { ...paypal, refundId },
        detail: { refundId: row!.id, refundStatus: "COMPLETED", reason: story.refund.reason },
      },
      new Date(refundedAt.getTime() + 5 * SECOND_MS),
    );
    state = "refunded";
  }
  return settle(tx, caseId, state, last);
}

/** A capture the seeded discharge wrote. */
interface SeededCapture {
  readonly id: string;
  readonly hold: SeededHold;
  readonly paypalCaptureId: string;
  readonly amountPence: number;
}

/**
 * Signs a seeded case's bill off and closes each of its holds as U7's
 * discharge does (U7's "To U9"): the bill, its lines and their allocation by
 * U3's own allocator; one final capture per hold the bill takes from,
 * completed and confirmed; a void for a hold it takes nothing from; the
 * holds closed; `bill.signed_off` with each hold's share, then
 * `hold.captured` or `hold.voided` per hold in the order they were made, the
 * case's state moving as U3's `dischargedState` moves it.
 *
 * @param tx - The transaction.
 * @param write - The case, its holds, the lines done, when, its state and the event writer.
 * @param write.practiceId - The practice.
 * @param write.caseId - The case.
 * @param write.holds - Its authorised holds, in the order they were made.
 * @param write.lines - What was done.
 * @param write.signedOffAt - When the vet signed the bill off.
 * @param write.state - The case's state before.
 * @param write.event - Writes a seeded event.
 * @param write.money - Money in the case's currency.
 * @returns The case's state after and the captures made.
 * @throws Error when a line done is not on the latest approved version.
 */
async function discharge(
  tx: Transaction,
  write: {
    practiceId: string;
    caseId: string;
    holds: readonly SeededHold[];
    lines: readonly { code: string; quantity: number }[];
    signedOffAt: Date;
    state: MoneyState;
    event: (input: Omit<AuditEventInput, "practiceId" | "caseId">, when: Date) => Promise<void>;
    money: (pence: number) => { pence: number; currency: "GBP" | "USD" };
  },
): Promise<{ state: MoneyState; captures: SeededCapture[] }> {
  const latest = write.holds.at(-1)!.version;
  const billed = write.lines.map(({ code, quantity }) => {
    const line = latest.lines.find((one) => one.code === code);
    if (!line) {
      throw new Error(`the seeded bill's ${code} is not on the approved estimate`);
    }
    return { line, quantity, amountPence: line.unitPricePence * quantity };
  });
  const plan = allocateBill(
    approvalsByHold(
      write.holds.map((one) => ({
        holdId: one.id,
        items: one.version.lines.map((line) => ({ code: line.code, highPence: line.highPence })),
      })),
    ),
    billed.map(({ line, amountPence }) => ({ code: line.code, amountPence })),
  );

  const [signed] = await tx
    .insert(bill)
    .values({
      practiceId: write.practiceId,
      caseId: write.caseId,
      currencyCode: write.money(0).currency,
      totalPence: plan.billedPence,
      signedOffBy: "vet",
      signedOffAt: write.signedOffAt,
    })
    .returning({ id: bill.id });
  const stored = await tx
    .insert(billLine)
    .values(
      billed.map(({ line, quantity }, position) => ({
        billId: signed!.id,
        position: position + 1,
        estimateLineId: line.id,
        quantity,
        unitPricePence: line.unitPricePence,
      })),
    )
    .returning({ id: billLine.id, position: billLine.position });
  const lineId = new Map(stored.map((row) => [row.position, row.id]));
  await tx.insert(allocation).values(
    plan.byLine.flatMap((parts, position) =>
      parts.map((part) => ({
        billLineId: lineId.get(position + 1)!,
        holdId: part.holdId,
        amountPence: part.amountPence,
      })),
    ),
  );
  const shares = write.holds.map((one) => {
    const capturePence = plan.byHold.get(one.id) ?? 0;
    return {
      hold: one,
      capturePence,
      releasePence: one.amountPence - capturePence,
      closeBy: capturePence > 0 ? ("final_capture" as const) : ("void" as const),
    };
  });
  await write.event(
    {
      actor: "vet",
      action: "bill.signed_off",
      moneyStateBefore: write.state,
      moneyStateAfter: write.state,
      amount: write.money(plan.billedPence),
      detail: {
        billId: signed!.id,
        lineCount: billed.length,
        holds: shares.map((share) => ({
          holdId: share.hold.id,
          capturePence: share.capturePence,
          releasePence: share.releasePence,
          closeBy: share.closeBy,
        })),
        releasedPence: plan.releasedPence,
      },
    },
    write.signedOffAt,
  );

  let state = write.state;
  let capturedPence = 0;
  let releasedPence = 0;
  const captures: SeededCapture[] = [];
  for (const [index, share] of shares.entries()) {
    const when = new Date(write.signedOffAt.getTime() + (index + 1) * 3 * SECOND_MS);
    const paypal = { orderId: share.hold.orderId, authorizationId: share.hold.authorizationId };
    capturedPence += share.capturePence;
    releasedPence += share.releasePence;
    const open = index < shares.length - 1;
    const before = state;
    state = open
      ? capturedPence > 0
        ? "captured"
        : state
      : releasedPence > 0
        ? "released"
        : "captured";
    if (share.closeBy === "final_capture") {
      const paypalCaptureId = seededPayPalId();
      const [taken] = await tx
        .insert(capture)
        .values({
          holdId: share.hold.id,
          sequence: 1,
          paypalCaptureId,
          authorizationId: share.hold.authorizationId,
          amountPence: share.capturePence,
          currencyCode: write.money(0).currency,
          finalCapture: true,
          status: "completed",
          capturedAt: when,
          confirmedAt: new Date(when.getTime() + WEBHOOK_LAG_MS),
          createdAt: when,
          updatedAt: when,
        })
        .returning({ id: capture.id });
      captures.push({
        id: taken!.id,
        hold: share.hold,
        paypalCaptureId,
        amountPence: share.capturePence,
      });
      await tx
        .update(hold)
        .set({ status: "captured", closedAt: when, updatedAt: when })
        .where(eq(hold.id, share.hold.id));
      await write.event(
        {
          actor: "system",
          action: "hold.captured",
          moneyStateBefore: before,
          moneyStateAfter: state,
          amount: write.money(share.capturePence),
          paypal: { ...paypal, captureId: paypalCaptureId },
          detail: {
            holdId: share.hold.id,
            finalCapture: true,
            captureStatus: "COMPLETED",
            releasedPence: share.releasePence,
          },
        },
        when,
      );
    } else {
      await tx
        .update(hold)
        .set({ status: "voided", closedAt: when, updatedAt: when })
        .where(eq(hold.id, share.hold.id));
      await write.event(
        {
          actor: "system",
          action: "hold.voided",
          moneyStateBefore: before,
          moneyStateAfter: state,
          amount: write.money(share.releasePence),
          paypal,
          detail: { holdId: share.hold.id, closedBy: "void", releasedPence: share.releasePence },
        },
        when,
      );
    }
  }
  return { state, captures };
}

/**
 * Authorises a seeded hold's row: its authorisation ids seeded, its 29 days
 * from its authorisation, its webhook's confirmation a few seconds after.
 *
 * @param tx - The transaction.
 * @param write - The hold, its version, amount, order, payment and time.
 * @param write.holdId - The hold.
 * @param write.version - Its version.
 * @param write.amountPence - What it holds.
 * @param write.orderId - Its order.
 * @param write.payment - How the owner paid.
 * @param write.authorisedAt - When.
 * @returns The hold.
 */
async function authorise(
  tx: Transaction,
  write: {
    holdId: string;
    version: SeededVersion;
    amountPence: number;
    orderId: string;
    payment: SeededPayment;
    authorisedAt: Date;
  },
): Promise<SeededHold> {
  const authorizationId = seededPayPalId();
  const expiresAt = new Date(write.authorisedAt.getTime() + AUTHORISATION_PERIOD_MS);
  await tx
    .update(hold)
    .set({
      status: "authorised",
      authorizationId,
      originalAuthorizationId: authorizationId,
      paymentKind: write.payment,
      authorisedAt: write.authorisedAt,
      expiresAt,
      confirmedAt: new Date(write.authorisedAt.getTime() + WEBHOOK_LAG_MS),
      updatedAt: write.authorisedAt,
    })
    .where(eq(hold.id, write.holdId));
  return {
    id: write.holdId,
    version: write.version,
    amountPence: write.amountPence,
    orderId: write.orderId,
    authorizationId,
    expiresAt,
  };
}

/**
 * Sets a seeded case's state and its last change to its story's last event.
 *
 * @param tx - The transaction.
 * @param caseId - The case.
 * @param state - The state its story left it in.
 * @param at - Its story's last event.
 * @returns The case and its state.
 */
async function settle(
  tx: Transaction,
  caseId: string,
  state: MoneyState,
  at: Date,
): Promise<WrittenCase> {
  await tx
    .update(patientCase)
    .set({ moneyState: state, updatedAt: at })
    .where(eq(patientCase.id, caseId));
  return { caseId, state };
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
 * @throws Error when a line's item is not on the list.
 */
async function writeSentVersion(
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
      throw new Error(`the showcase's ${line.code} is not on the practice's price list`);
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
  const stored = await tx
    .insert(estimateLine)
    .values(
      priced.map(({ line, item }, position) => ({
        versionId,
        priceListId: write.list.id,
        position: position + 1,
        priceListItemId: item.id,
        unitPricePence: item.unitPricePence,
        quantityLow: line.quantityLow,
        quantityHigh: line.quantityHigh,
        dependsOn: line.dependsOn ?? null,
        notesSpan: line.notesSpan ?? null,
        ownerWording: line.ownerWording ?? null,
      })),
    )
    .returning({ id: estimateLine.id, position: estimateLine.position });
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
  const idAt = new Map(stored.map((row) => [row.position, row.id]));
  return {
    id: versionId,
    number: write.number,
    priceListId: write.list.id,
    lowPence,
    highPence,
    lines: priced.map(({ line, item }, position) => ({
      id: idAt.get(position + 1)!,
      code: line.code,
      unitPricePence: item.unitPricePence,
      highPence: item.unitPricePence * line.quantityHigh,
    })),
  };
}

type SeededEvent = Omit<AuditEventInput, "practiceId" | "caseId">;

/**
 * `estimate.version_made`, as U2 writes it.
 *
 * @param version - The version.
 * @returns The event.
 */
function versionMade(version: SeededVersion): SeededEvent {
  return {
    actor: "vet",
    action: "estimate.version_made",
    detail: {
      versionId: version.id,
      number: version.number,
      priceListId: version.priceListId,
      lineCount: version.lines.length,
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
function approved(version: SeededVersion, vetName: string): SeededEvent {
  return {
    actor: "vet",
    action: "estimate.approved",
    detail: {
      versionId: version.id,
      number: version.number,
      vetName,
      lowPence: version.lowPence,
      highPence: version.highPence,
      lineCount: version.lines.length,
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
  currency: "GBP" | "USD",
  before: "estimate_draft" | "held",
  after: "awaiting_owner" | "update_awaiting_owner",
): SeededEvent {
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
 * `hold.ordered`, the owner opening PayPal's checkout, as U3 writes it.
 *
 * @param holdId - The hold.
 * @param versionNumber - Its version's number.
 * @param amountPence - What it would hold.
 * @param heldBeforePence - What the case held before it.
 * @param orderId - Its order.
 * @param currency - Its currency.
 * @returns The event.
 */
function ordered(
  holdId: string,
  versionNumber: number,
  amountPence: number,
  heldBeforePence: number,
  orderId: string,
  currency: "GBP" | "USD",
): SeededEvent {
  return {
    actor: "owner",
    action: "hold.ordered",
    amount: { pence: amountPence, currency },
    paypal: { orderId },
    detail: { holdId, versionNumber, heldBeforePence },
  };
}

/**
 * `hold.authorised`, as U3 writes it.
 *
 * @param held - The hold.
 * @param versionNumber - Its version's number.
 * @param payment - How the owner paid.
 * @param currency - Its currency.
 * @param before - The case's state before.
 * @param after - The case's state after.
 * @returns The event.
 */
function authorised(
  held: SeededHold,
  versionNumber: number,
  payment: SeededPayment,
  currency: "GBP" | "USD",
  before: MoneyState,
  after: MoneyState,
): SeededEvent {
  return {
    actor: "owner",
    action: "hold.authorised",
    moneyStateBefore: before,
    moneyStateAfter: after,
    amount: { pence: held.amountPence, currency },
    paypal: { orderId: held.orderId, authorizationId: held.authorizationId },
    detail: {
      holdId: held.id,
      versionNumber,
      paymentKind: payment,
      expiresAt: held.expiresAt.toISOString(),
    },
  };
}
