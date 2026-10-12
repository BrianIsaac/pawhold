import type { CurrencyCode } from "@/money/currency";
import { formatMoney } from "@/money/format";

/*
 * The discharge page's words. Section 6 drafts the heading, the refusal of a
 * line not on an approved estimate, the allocation sentence for two holds and
 * the confirm button; the rest are this unit's, flagged (D11).
 */

/**
 * Section 6's refusal of a line not on an approved estimate, as U3's
 * `NOT_ON_ESTIMATE` words it; kept here too so the page's client code does
 * not load the money lifecycle's server modules (a test holds the two equal).
 */
export const NOT_ON_ESTIMATE = "Not on an approved estimate. Send an update to charge it.";

/** Section 6's heading. */
export const BILL_HEADING = "Itemised bill";

/**
 * Money in the case's currency, as every screen shows it.
 *
 * @param pence - The amount.
 * @param currency - The case's currency.
 * @returns The amount, as "£1,147.00".
 */
export function money(pence: number, currency: CurrencyCode): string {
  return formatMoney({ pence, currency });
}

/**
 * What a hold is called, by its place among the case's holds: "the first
 * hold" and "the update's hold" (section 6), and with more than one update
 * "the first update's hold", "the second update's hold", and so on.
 *
 * @param index - The hold's place, from 0, in the order the holds were made.
 * @param count - How many holds the case has.
 * @returns The name, lower case.
 */
export function holdName(index: number, count: number): string {
  if (index === 0) {
    return count === 1 ? "the hold" : "the first hold";
  }
  if (count === 2) {
    return "the update's hold";
  }
  return `the ${ordinal(index)} update's hold`;
}

/**
 * The heading over the lines one approved version brought to the bill.
 *
 * @param index - The version's place among the approved ones, from 0.
 * @param count - How many versions the owner approved.
 * @returns The heading.
 */
export function approvedWithHeading(index: number, count: number): string {
  if (index === 0) {
    return "Approved with the estimate";
  }
  return count === 2 ? "Approved with the update" : `Approved with the ${ordinal(index)} update`;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

/**
 * An ordinal in words up to "eighth", then in figures.
 *
 * @param n - The number, from 1.
 * @returns "first", "second", ..., "9th".
 */
function ordinal(n: number): string {
  return ORDINALS[n - 1] ?? `${n}th`;
}

/**
 * The line a quantity above what the owner approved is refused with (U3's
 * words): "{n} done, {high} approved. Send an update to charge the rest."
 *
 * @param done - The quantity done.
 * @param approved - The quantity the owner approved.
 * @returns The sentence.
 */
export function aboveApproved(done: number, approved: number): string {
  return `${done} done, ${approved} approved. Send an update to charge the rest.`;
}

/**
 * Why the bill cannot be confirmed when it is above what is held: nothing
 * above a hold is captured (rule 1).
 *
 * @param billedPence - The bill.
 * @param heldPence - What the holds hold.
 * @param currency - The case's currency.
 * @returns The sentence.
 */
export function aboveHolds(billedPence: number, heldPence: number, currency: CurrencyCode): string {
  return `The bill is ${money(billedPence, currency)}, above the ${money(heldPence, currency)} held. Nothing above a hold is charged: send an update for the rest, or change the bill.`;
}

/** Why the bill cannot be confirmed while a line is above what the owner approved. */
export const LINE_ABOVE_APPROVED =
  "A line is above what the owner approved. Change it, or send an update to charge it.";

/** Why the bill cannot be confirmed while a quantity is not a whole number. */
export const QUANTITY_INVALID = "Every quantity done must be a whole number.";

/**
 * Why a case whose holds were seeded for the demo cannot be charged: its
 * PayPal ids are not PayPal's, so PayPal would refuse every capture.
 */
export const SEEDED_HOLDS =
  "This case's holds were seeded for the demo and are not PayPal's, so they can't be charged. Nothing has been charged. Discharge a case whose owner authorised a hold.";

/** Why a case with nothing held cannot be discharged. */
export const NOTHING_HELD = "Nothing is held for this case, so there is nothing to charge.";

/** The quantity field's fault when it is not a whole number. */
export const WHOLE_NUMBER = "Enter a whole number";

/**
 * The hint under a line's quantity: what the estimate expected and the owner approved.
 *
 * @param low - The estimate's least.
 * @param high - The most approved.
 * @returns The hint.
 */
export function quantityHint(low: number, high: number): string {
  return low === high ? `Approved: ${high}` : `Approved: ${low} to ${high}`;
}
