import { and, desc, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/db/client";
import type { moneyState } from "@/db/schema";
import { auditEvent, patientCase, practice } from "@/db/schema";
import { type CurrencyCode, currencyCode } from "@/money/currency";

import { MoneyError } from "./errors";

/** A case's money state, as the practice's board colours it (plan 3.2). */
export type MoneyState = (typeof moneyState.enumValues)[number];

/**
 * The case's money state machine, exactly as plan 3.2 draws it, by the event
 * that moves it: for each event, the states it may happen in and the state it
 * leads to. Discharge's states (captured, released) are reached by the
 * captures and voids themselves (`dischargedState`), refunds from either.
 * "Held (two holds)" is `held` with two holds; "honour period over" and
 * "hold extended" are flags on a hold, not states of the case.
 */
export const MONEY_TRANSITIONS = {
  /** draft estimate --send--> awaiting owner (and a withdrawn estimate sent again). */
  send_estimate: { estimate_draft: "awaiting_owner", withdrawn: "awaiting_owner" },
  /** held --vet adds work, trigger met--> update awaiting owner; also after a declined update. */
  send_update: { held: "update_awaiting_owner", update_declined: "update_awaiting_owner" },
  /** awaiting owner --owner authorises--> held; update awaiting owner --> held (two holds). */
  authorise: { awaiting_owner: "held", update_awaiting_owner: "held" },
  /** awaiting owner --estimate withdrawn--> withdrawn. An update withdrawn returns to where it was sent from. */
  withdraw: { awaiting_owner: "withdrawn", update_awaiting_owner: null },
  /** held --owner declines the update--> held, update declined (scope frozen at what is held). */
  decline_update: { update_awaiting_owner: "update_declined" },
  /** The vet signs the bill off: the case stays as it is until the captures land. */
  sign_off: { held: "held", update_declined: "update_declined" },
  /** captured --goodwill or correction--> refunded (part or whole). */
  refund: { captured: "refunded", released: "refunded", refunded: "refunded" },
} as const satisfies Record<string, Partial<Record<MoneyState, MoneyState | null>>>;

export type MoneyEvent = keyof typeof MONEY_TRANSITIONS;

/**
 * Where an event leads from a state.
 *
 * @param event - The event.
 * @param from - The case's state.
 * @returns The next state, or null when the next state is not fixed by the table (an update withdrawn).
 * @throws MoneyError when the event cannot happen in that state.
 */
export function nextState(event: MoneyEvent, from: MoneyState): MoneyState | null {
  const row: Partial<Record<MoneyState, MoneyState | null>> = MONEY_TRANSITIONS[event];
  if (!(from in row)) {
    const allowed = Object.keys(row).join(", ");
    throw new MoneyError(
      "wrong_state",
      `${event.replaceAll("_", " ")} cannot happen to a case that is ${from.replaceAll("_", " ")} (only ${allowed.replaceAll("_", " ")})`,
    );
  }
  return row[from] ?? null;
}

/** A case locked for a money change. */
export interface LockedCase {
  readonly id: string;
  readonly practiceId: string;
  readonly practiceName: string;
  readonly patientName: string;
  readonly moneyState: MoneyState;
  readonly currency: CurrencyCode;
}

/**
 * Locks a practice's case for a money change, so a case's money changes one
 * at a time.
 *
 * @param tx - The open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The case.
 * @throws MoneyError when the practice has no such case.
 */
export async function lockCase(
  tx: Transaction,
  practiceId: string,
  caseId: string,
): Promise<LockedCase> {
  const [found] = await tx
    .select({
      id: patientCase.id,
      practiceId: patientCase.practiceId,
      practiceName: practice.name,
      patientName: patientCase.patientName,
      moneyState: patientCase.moneyState,
      currencyCode: patientCase.currencyCode,
    })
    .from(patientCase)
    .innerJoin(practice, eq(practice.id, patientCase.practiceId))
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)))
    .for("update", { of: patientCase });
  if (!found) {
    throw new MoneyError("case_not_found", `the practice has no case ${caseId}`);
  }
  const { currencyCode: currency, ...rest } = found;
  return { ...rest, currency: currencyCode.parse(currency) };
}

/**
 * Moves a locked case to a money state.
 *
 * @param tx - The open transaction that locked it.
 * @param caseId - The case.
 * @param to - The state.
 * @returns Resolves once moved.
 */
export async function moveCase(tx: Transaction, caseId: string, to: MoneyState): Promise<void> {
  await tx
    .update(patientCase)
    .set({ moneyState: to, updatedAt: sql`now()` })
    .where(eq(patientCase.id, caseId));
}

/**
 * The state an update was sent from (held, or held with an update declined),
 * read from the `estimate.sent` event that moved the case to awaiting the
 * owner's answer on the update; an update withdrawn returns the case there.
 *
 * @param tx - The open transaction.
 * @param caseId - The case.
 * @returns The state.
 */
export async function stateBeforeUpdate(tx: Transaction, caseId: string): Promise<MoneyState> {
  const [sent] = await tx
    .select({ before: auditEvent.moneyStateBefore })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.caseId, caseId),
        eq(auditEvent.action, "estimate.sent"),
        eq(auditEvent.moneyStateAfter, "update_awaiting_owner"),
      ),
    )
    .orderBy(desc(auditEvent.id))
    .limit(1);
  return sent?.before ?? "held";
}
