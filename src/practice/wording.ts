import type { UpdateTriggerCheck } from "@/estimate/trigger";
import type { CurrencyCode } from "@/money/currency";
import { formatMoney, formatPercent } from "@/money/format";

/**
 * The practice's screens' words. Those section 6 drafts are built as drafted
 * (D11); those it does not draft are this unit's and are flagged in the
 * handover. Every amount is formatted by code; none is written by the model.
 */

/** Section 6: the notes box's label. */
export const NOTES_LABEL = "Clinical notes";

/** Section 6: the notes box's placeholder. */
export const NOTES_PLACEHOLDER = "Type or paste your notes, as you would write them.";

/** Section 6: the draft button. */
export const DRAFT_BUTTON = "Draft estimate";

/** This unit's: before a redraft (U4: "U5's screen should say so before the press"). */
export const REDRAFT_WARNING =
  "Drafting again replaces the lines of this draft, including any you added by hand.";

/**
 * Section 6: the total and the hold (D3: the hold is the top of the range).
 *
 * @param totals - The range in pence.
 * @param totals.lowPence - The low end.
 * @param totals.highPence - The high end.
 * @param currency - Its currency.
 * @returns The sentence.
 */
export function estimateTotal(
  totals: { lowPence: number; highPence: number },
  currency: CurrencyCode,
): string {
  const low = formatMoney({ pence: totals.lowPence, currency });
  const high = formatMoney({ pence: totals.highPence, currency });
  return `Estimate ${low} to ${high}. The hold will be ${high}.`;
}

/**
 * Section 6: the send button.
 *
 * @param ownerFirstName - The owner's first name.
 * @returns The label.
 */
export function sendTo(ownerFirstName: string): string {
  return `Send to ${ownerFirstName}`;
}

/**
 * Section 6: the confirmation once sent.
 *
 * @param ownerFirstName - The owner's first name.
 * @returns The sentence.
 */
export function sentConfirmation(ownerFirstName: string): string {
  return `Sent. ${ownerFirstName} can authorise the hold from the link on their phone.`;
}

/**
 * A line's quantity or range against its unit price (section 6: "the
 * quantity or range"; the form of words is this unit's).
 *
 * @param line - The quantities, the unit price and the unit.
 * @param line.quantityLow - The least.
 * @param line.quantityHigh - The most.
 * @param line.unitPricePence - The unit price.
 * @param line.unit - The unit.
 * @param currency - The currency.
 * @returns The words.
 */
export function lineQuantity(
  line: { quantityLow: number; quantityHigh: number; unitPricePence: number; unit: string },
  currency: CurrencyCode,
): string {
  const quantity =
    line.quantityLow === line.quantityHigh
      ? String(line.quantityHigh)
      : `${line.quantityLow} to ${line.quantityHigh}`;
  return `${quantity} at ${formatMoney({ pence: line.unitPricePence, currency })} per ${line.unit}`;
}

/**
 * A line's price, a range when its quantity is one (section 6: "the price").
 *
 * @param line - Its money.
 * @param line.lowPence - The low end.
 * @param line.highPence - The high end.
 * @param currency - The currency.
 * @returns The price.
 */
export function linePrice(
  line: { lowPence: number; highPence: number },
  currency: CurrencyCode,
): string {
  const high = formatMoney({ pence: line.highPence, currency });
  return line.lowPence === line.highPence
    ? high
    : `${formatMoney({ pence: line.lowPence, currency })} to ${high}`;
}

/** Section 6: the update's label. */
export const FINDING_LABEL = "What did you find, and what do you recommend?";

/** Section 6: the update's photo control. */
export const PHOTO_LABEL = "Add a photo";

/** Section 6: whether the owner sees the photo. */
export const SHARE_PHOTO_LABEL = "Show the photo to the owner";

/** This unit's: the update's draft button (section 6 names none). */
export const DRAFT_UPDATE_BUTTON = "Draft the update";

/** What the trigger sentence is made from. */
export interface TriggerSentenceInput {
  /** What the update asks for over what is held (U3's `updateIncrease`). */
  readonly increasePence: number;
  /** What the case's holds hold. */
  readonly heldPence: number;
  /** The Order's check against the original written estimate (U2's `checkEstimateTrigger`). */
  readonly check: UpdateTriggerCheck | null;
  readonly currency: CurrencyCode;
  readonly ownerFirstName: string;
}

/**
 * Section 6's trigger sentence, by code. When the original written estimate
 * is what is held (a first update, or one after a declined update) it is
 * section 6's sentence as drafted. After an approved update, what is held
 * and the Order's base part, and the sentence names both (this unit's form
 * of words, flagged). An update that adds nothing over the hold says so.
 *
 * @param input - The increase, what is held, the Order's check, the currency and the owner.
 * @returns The sentence.
 */
export function triggerSentence(input: TriggerSentenceInput): string {
  const money = (pence: number): string => formatMoney({ pence, currency: input.currency });
  if (input.increasePence <= 0) {
    return `This update adds nothing over what is held, so there is nothing to ask ${input.ownerFirstName} for.`;
  }
  const delta = money(input.increasePence);
  const check = input.check;
  if (!check) {
    return `This adds ${delta}.`;
  }
  const order = `The CMA's Order asks for an updated written estimate at 20% or ${money(check.thresholdPence)}, whichever is lower: this one ${check.met ? "meets" : "does not meet"} it. pawhold asks the owner either way, because nothing over the hold is charged without their yes.`;
  const percent =
    check.increaseBasisPoints === null ? null : formatPercent(check.increaseBasisPoints);
  if (check.originalPence === input.heldPence) {
    return `This adds ${delta}${percent === null ? "" : `, ${percent}% over the held estimate`}. ${order}`;
  }
  return `This adds ${delta} to what is held${percent === null ? "" : `; with the updates approved before it, the estimate is ${percent}% over the original written estimate of ${money(check.originalPence)}`}. ${order}`;
}

/**
 * Section 6: the update's send button.
 *
 * @param ownerFirstName - The owner's first name.
 * @param increasePence - What the update asks for over what is held.
 * @param currency - The currency.
 * @returns The label.
 */
export function askToApprove(
  ownerFirstName: string,
  increasePence: number,
  currency: CurrencyCode,
): string {
  return `Ask ${ownerFirstName} to approve ${formatMoney({ pence: increasePence, currency })}`;
}

/**
 * This unit's: the confirmation once an update is sent.
 *
 * @param ownerFirstName - The owner's first name.
 * @returns The sentence.
 */
export function updateSentConfirmation(ownerFirstName: string): string {
  return `Sent. ${ownerFirstName} can approve the update from the link on their phone.`;
}

/**
 * This unit's: the decline shown on the case.
 *
 * @param ownerFirstName - The owner's first name.
 * @param day - The day it was declined, as the practice reads it.
 * @param heldPence - What stays held.
 * @param currency - The currency.
 * @returns The sentence.
 */
export function updateDeclined(
  ownerFirstName: string,
  day: string,
  heldPence: number,
  currency: CurrencyCode,
): string {
  return `${ownerFirstName} declined this update on ${day}. The case stays held at ${formatMoney({ pence: heldPence, currency })}: only what ${ownerFirstName} approved is done.`;
}

/**
 * This unit's: once the estimate is withdrawn.
 *
 * @param ownerFirstName - The owner's first name.
 * @returns The sentence.
 */
export function estimateWithdrawn(ownerFirstName: string): string {
  return `Withdrawn. ${ownerFirstName} can no longer authorise it.`;
}

/**
 * This unit's: once an update is withdrawn.
 *
 * @param ownerFirstName - The owner's first name.
 * @returns The sentence.
 */
export function updateWithdrawn(ownerFirstName: string): string {
  return `Update withdrawn. What ${ownerFirstName} approved before stays held.`;
}
