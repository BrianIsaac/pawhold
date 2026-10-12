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

/** A hold's part in a discharge, as the sentence reads it. */
export interface HoldShare {
  readonly capturePence: number;
  readonly releasePence: number;
}

/**
 * Section 6's sentence before confirming: "{amount} will be captured: {a}
 * from the first hold, {b} from the update's hold. {c} will be released to
 * {owner first name}." With one hold it names the hold once; with several
 * updates it names each update's hold in order; a hold that pays nothing
 * pays "nothing"; and it says so when nothing is captured or left to release.
 *
 * @param holds - Each hold's capture and release, in the order the holds were made.
 * @param currency - The case's currency.
 * @param ownerFirstName - The owner's first name.
 * @returns The sentence.
 */
export function allocationSentence(
  holds: readonly HoldShare[],
  currency: CurrencyCode,
  ownerFirstName: string,
): string {
  const captured = holds.reduce((sum, one) => sum + one.capturePence, 0);
  const released = holds.reduce((sum, one) => sum + one.releasePence, 0);
  let captures: string;
  if (captured === 0) {
    captures = "Nothing will be captured.";
  } else if (holds.length === 1) {
    captures = `${money(captured, currency)} will be captured from the hold.`;
  } else {
    const parts = holds.map(
      (one, at) =>
        `${one.capturePence === 0 ? "nothing" : money(one.capturePence, currency)} from ${holdName(at, holds.length)}`,
    );
    captures = `${money(captured, currency)} will be captured: ${parts.join(", ")}.`;
  }
  const releases =
    released === 0
      ? "Nothing is left to release."
      : `${money(released, currency)} will be released to ${ownerFirstName}.`;
  return `${captures} ${releases}`;
}

/**
 * The confirm button (section 6): "Confirm and charge {amount}"; when the
 * bill charges nothing, what confirming does instead.
 *
 * @param capturedPence - What will be captured.
 * @param releasedPence - What will be released.
 * @param currency - The case's currency.
 * @returns The label.
 */
export function confirmLabel(
  capturedPence: number,
  releasedPence: number,
  currency: CurrencyCode,
): string {
  return capturedPence > 0
    ? `Confirm and charge ${money(capturedPence, currency)}`
    : `Confirm and release ${money(releasedPence, currency)}`;
}

/** Why a confirm is refused when the bill changed since the page showed it. */
export const BILL_CHANGED =
  "The bill changed since it was shown. Check it again before confirming.";

/** Why a confirm is refused when the bill was signed off already. */
export const SIGNED_ALREADY =
  "The bill was signed off already. The page shows the discharge as it is now.";

/**
 * A hold's name at the head of its progress: "The first hold", "The update's hold".
 *
 * @param index - The hold's place, from 0, in the order the holds were made.
 * @param count - How many holds the bill was signed off against.
 * @returns The name.
 */
export function holdTitle(index: number, count: number): string {
  const name = holdName(index, count);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Why nothing can be charged on a server without PayPal's credentials. */
export const PAYPAL_NOT_SET_UP =
  "PayPal isn't set up on this server, so nothing can be charged. Nothing has been charged.";

/**
 * A discharge step's refusal in the vet's words.
 *
 * @param reason - U3's reason.
 * @param issues - PayPal's issue names, when PayPal refused.
 * @returns The sentence.
 */
export function dischargeRefusal(reason: string, issues: readonly string[]): string {
  switch (reason) {
    case "paypal_unavailable":
      return "PayPal didn't answer. Nothing is captured twice: resume in a moment to finish.";
    case "paypal_refused":
      return `PayPal refused a step${issues.length > 0 ? ` (${issues.join(", ")})` : ""}. What landed stands; the rest is shown as it is now.`;
    case "bill_refused":
    case "bill_above_holds":
      return "The bill was refused. The page shows it as it is now.";
    default:
      return "The case moved on since the page was opened. It shows as it is now.";
  }
}

/**
 * The case page's confirmation once a refund is made.
 *
 * @param ownerFirstName - The owner's first name.
 * @returns The confirmation.
 */
export function refundedConfirmation(ownerFirstName: string): string {
  return `Refunded to ${ownerFirstName}. The timeline and ${ownerFirstName}'s receipt show it.`;
}

/**
 * A charge as the refund form offers it.
 *
 * @param holdName - The hold it was taken from, lower case.
 * @param leftPence - What is left of it to refund.
 * @param capturedPence - What it took.
 * @param currency - The case's currency.
 * @returns The option's words.
 */
export function chargeOption(
  holdName: string,
  leftPence: number,
  capturedPence: number,
  currency: CurrencyCode,
): string {
  const from = holdName.charAt(0).toUpperCase() + holdName.slice(1);
  return leftPence === capturedPence
    ? `${from}, ${money(capturedPence, currency)}`
    : `${from}, ${money(leftPence, currency)} of ${money(capturedPence, currency)} left`;
}
