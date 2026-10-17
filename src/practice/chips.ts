import { formatMoney } from "@/money/format";
import type { MoneyState } from "@/money/state";
import type { CaseMoney } from "@/money/view";

/** A chip's tone: a money state, or a flag on an open hold. */
export type MoneyChipTone = MoneyState | "extended" | "honour_period_over";

/** One chip: its tone (the board's colour) and its words. */
export interface MoneyChip {
  readonly tone: MoneyChipTone;
  readonly label: string;
}

/**
 * The chips a case shows: its money state in section 6's words (U3's map),
 * then a flag for any open hold extended or past its honour period. Section 6
 * drafts no chip for a withdrawn estimate; "Withdrawn" is this unit's.
 *
 * @param money - The case's money, from U3's `caseMoney`.
 * @returns The chips, the state's first.
 */
export function moneyChips(money: CaseMoney): MoneyChip[] {
  const amount = (pence: number): string => formatMoney({ pence, currency: money.currency });
  const chips: MoneyChip[] = [{ tone: money.state, label: stateLabel(money, amount) }];
  const open = money.holds.filter((hold) => hold.status === "authorised");
  if (open.some((hold) => hold.reauthorisedAt !== null)) {
    chips.push({ tone: "extended", label: "Hold extended" });
  }
  if (open.some((hold) => hold.honourPeriodFlaggedAt !== null)) {
    chips.push({ tone: "honour_period_over", label: "Honour period over" });
  }
  return chips;
}

/**
 * A money state's chip words.
 *
 * @param money - The case's money.
 * @param amount - Formats pence in the case's currency.
 * @returns The words.
 */
function stateLabel(money: CaseMoney, amount: (pence: number) => string): string {
  switch (money.state) {
    case "estimate_draft":
      return "Estimate draft";
    case "awaiting_owner":
      return "Waiting for owner";
    case "held":
      return `Held ${amount(money.heldPence)}`;
    case "update_awaiting_owner":
      return "Update waiting";
    case "update_declined":
      return "Update declined";
    case "captured":
      return `Captured ${amount(money.capturedPence)}`;
    case "released":
      return `Released ${amount(money.releasedPence)}`;
    case "refunded":
      return `Refunded ${amount(money.refundedPence)}`;
    case "withdrawn":
      return "Withdrawn";
  }
}

/** What the next step depends on beside the state. */
export interface NextStepContext {
  readonly ownerFirstName: string;
  /** Whether the case has a draft with lines in it. */
  readonly hasDraftLines: boolean;
  /** Whether a hold it stands on is past its honour period and cannot be extended (U9's finding, U11). */
  readonly honourPeriodOver: boolean;
}

/**
 * The next thing the practice does on a case, for today's "Next" column.
 * Section 6 names the column and drafts none of its words: these are this
 * unit's (flagged, D11).
 *
 * @param state - The case's money state.
 * @param context - The owner's first name and whether a draft has lines.
 * @returns The step in words.
 */
export function nextStep(state: MoneyState, context: NextStepContext): string {
  switch (state) {
    case "estimate_draft":
      return context.hasDraftLines ? "Review and send the estimate" : "Draft the estimate";
    case "awaiting_owner":
      return `Wait for ${context.ownerFirstName} to authorise the hold`;
    case "held":
      // A hold past its honour period, its one reauthorisation spent or
      // refused, may no longer be captured: the owner is asked to authorise
      // it again (U11, flagged).
      return context.honourPeriodOver
        ? `Ask ${context.ownerFirstName} for a new hold`
        : "Add an update, or discharge";
    case "update_awaiting_owner":
      return `Wait for ${context.ownerFirstName} to answer the update`;
    case "update_declined":
      return `Call ${context.ownerFirstName} about the update`;
    case "withdrawn":
      return "Send the estimate again";
    case "captured":
    case "released":
    case "refunded":
      return "Nothing to do";
  }
}

/**
 * An owner's first name, for "Send to {owner first name}" (section 6): the
 * first word of the name the practice holds.
 *
 * @param ownerName - The owner's name.
 * @returns The first word, or the whole name when it has one word.
 */
export function firstName(ownerName: string): string {
  return ownerName.trim().split(/\s+/)[0] ?? ownerName;
}
