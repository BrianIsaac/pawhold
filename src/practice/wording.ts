import type { CurrencyCode } from "@/money/currency";
import { formatMoney } from "@/money/format";

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
