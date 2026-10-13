/**
 * The words the owner's pages show, as plan section 6 drafts them. Every
 * string is a draft and the operator's to change (D11); where section 6 has
 * no draft for a case the page meets, the wording is this unit's and is
 * flagged in the handover. Money arrives already shown by code
 * (`formatPence`), never written here.
 */

import type { Species } from "@/practice/species";

/**
 * Who section 6's "{vet name}" is for a case opened before the practice
 * named its vet (`patient_case.vet_name` is null): "your vet". Flagged in
 * U6's handover.
 */
export const YOUR_VET = "your vet";

/**
 * Section 6's "{vet name}": the vet who opened the case, or "your vet" when
 * the case names none.
 *
 * @param vetName - The case's vet, or null.
 * @returns Who the owner's pages say the vet is.
 */
export function vetCalled(vetName: string | null): string {
  return vetName ?? YOUR_VET;
}

/**
 * A sentence's text with its first letter in capitals, for "{vet name}" at
 * the start of one.
 *
 * @param text - The text.
 * @returns The text, capitalised.
 */
export function capitalised(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/**
 * An expired or changed link's heading: the first sentence of section 6's
 * "This link has expired. Ask {practice} to send it again.", the second
 * under it ({@link askToSendAgain}), so the page does not say it twice.
 */
export const LINK_EXPIRED = "This link has expired";

/**
 * Under an expired or changed link's heading (section 6). A changed link
 * names no practice anyone can trust, so it asks the practice by no name:
 * this unit's wording.
 *
 * @param practiceName - The practice, when the link's signature holds.
 * @returns The sentence.
 */
export function askToSendAgain(practiceName: string | null): string {
  return `Ask ${practiceName ?? "the practice that sent it"} to send it again.`;
}

/**
 * The estimate page's heading (section 6).
 *
 * @param patient - The patient's name.
 * @param practice - The practice's name.
 * @returns The heading.
 */
export function estimateHeading(patient: string, practice: string): string {
  return `${patient}'s estimate from ${practice}`;
}

/**
 * The estimate page's introduction: what is held and why (section 6; D3,
 * the hold is the top of the range).
 *
 * @param vet - Who the vet is, as the page names them.
 * @param patient - The patient's name.
 * @param high - The top of the range, shown.
 * @returns The sentence.
 */
export function estimateIntro(vet: string, patient: string, high: string): string {
  return `This is what ${vet} expects ${patient}'s treatment to cost. Nothing is charged now: PayPal holds up to ${high}, and you'll only pay for what's done.`;
}

/**
 * The estimate's range (section 6); one figure when it has no range (U11, flagged).
 *
 * @param vet - Who the vet is, as the page names them.
 * @param low - The bottom of the range, shown.
 * @param high - The top of the range, shown.
 * @returns The sentence.
 */
export function rangeLine(vet: string, low: string, high: string): string {
  return `Likely ${low === high ? high : `${low} to ${high}`}, depending on what ${vet} finds.`;
}

/**
 * Below the buttons: nothing above the hold without the owner's yes
 * (section 6).
 *
 * @param vet - Who the vet is, as the page names them.
 * @param high - The hold, shown.
 * @returns The sentence.
 */
export function askFirst(vet: string, high: string): string {
  return `If ${vet} finds something that needs more, they'll ask you first. Nothing above ${high} is charged without your yes.`;
}

/**
 * A line's price: one figure, or its range when the quantity is a range.
 * Section 6 says "the price"; the range form is this unit's.
 *
 * @param low - The line at its low quantity, shown.
 * @param high - The line at its high quantity, shown.
 * @returns The price.
 */
export function linePrice(low: string, high: string): string {
  return low === high ? high : `${low} to ${high}`;
}

/** The list of lines, as assistive technology names it: this unit's wording. */
export const LINES_LABEL = "What the estimate covers";

/**
 * The card button's label on the estimate (section 6: "Authorise {high}").
 *
 * @param high - The hold, shown.
 * @returns The label.
 */
export function authoriseLabel(high: string): string {
  return `Authorise ${high}`;
}

/**
 * The card button's label on an update (section 6: "Approve {delta}").
 *
 * @param delta - The increase, shown.
 * @returns The label.
 */
export function approveLabel(delta: string): string {
  return `Approve ${delta}`;
}

/**
 * Once authorised (section 6: "Done. {high} is held on your {PayPal /
 * card}. You'll get the final bill at discharge.").
 *
 * @param amount - What is held, shown.
 * @param kind - How the owner paid.
 * @returns The sentence.
 */
export function heldDone(amount: string, kind: "paypal" | "card"): string {
  return `Done. ${amount} is held on your ${kind === "paypal" ? "PayPal" : "card"}. You'll get the final bill at discharge.`;
}

/** The hold's state once PayPal answered the authorisation (the brief's "Held"). */
export const HELD = "Held";

/**
 * Beside the hold, under the drawing of the animal content (the restyle's
 * mock-ups: proposed, the operator's to keep, reword or strike).
 *
 * @param patient - The patient's name.
 * @param vet - Who the vet is, as the page names them.
 * @returns The sentence.
 */
export function heldThanks(patient: string, vet: string): string {
  return `Thank you. ${patient} is in good hands with ${vet}.`;
}

/** Each species as the drawing of it is named, after "A line drawing of {name}, ". */
const DRAWN_AS: Readonly<Record<Species, string>> = {
  dog: "a dog",
  cat: "a cat",
  other: "another animal",
};

/**
 * What the drawing of the patient says to a screen reader: U17's words for
 * the species, with "a paw print" for an animal that is neither a dog nor a
 * cat, since that is what is drawn.
 *
 * @param patient - The patient's name.
 * @param species - Its species.
 * @param content - Whether it is drawn content, eyes closed (the "Held" moment).
 * @returns The words, such as "A line drawing of Otis, a dog, sitting".
 */
export function patientDrawn(patient: string, species: Species, content = false): string {
  if (species === "other") {
    return `A line drawing of a paw print, for ${patient}, ${DRAWN_AS[species]}`;
  }
  return `A line drawing of ${patient}, ${DRAWN_AS[species]}, sitting${content ? " happily" : ""}`;
}

const CONFIRMED_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Europe/London",
});

/**
 * The webhook's tick: PayPal's own event reconciled against the hold. The
 * time is UK time (D1), the same on the server and in the browser.
 *
 * @param at - When it was confirmed.
 * @returns The line.
 */
export function confirmedByPayPal(at: Date): string {
  return `Confirmed by PayPal ${CONFIRMED_TIME.format(at)}`;
}

/** While the page waits for the webhook's tick: this unit's wording. */
export const WAITING_FOR_PAYPAL = "Waiting for PayPal to confirm.";

/** A PayPal error on the owner's page (section 6). */
export const PAYPAL_ERROR =
  "PayPal couldn't complete that. Nothing has been charged. Try again, or use a card.";

/** Between PayPal's button and the card fields: this unit's wording. */
export const OR_USE_A_CARD = "Or use a card";

/**
 * Under the buttons: PayPal's own window shows the buyer a ceiling above the
 * order (U0's P1: "up to £125.00" on £100.00), which is not pawhold's. This
 * unit's wording.
 *
 * @param amount - What is held, shown.
 * @returns The sentence.
 */
export function paypalCeilingNote(amount: string): string {
  return `PayPal's window may show a higher "up to" figure. pawhold holds ${amount} and charges only the final bill.`;
}

/** When the server has no PayPal app to authorise with: this unit's wording. */
export function authorisingUnavailable(practice: string): string {
  return `Authorising isn't available on this page right now. Nothing has been charged. Ask ${practice} how to go ahead.`;
}

/** The card fields' labels: this unit's wording. */
export const CARD_FIELD_LABELS = {
  name: "Name on the card",
  number: "Card number",
  expiry: "Expiry date (MM/YY)",
  cvv: "Security code",
} as const;

/** The card fields' placeholders: this unit's wording. */
export const CARD_FIELD_PLACEHOLDERS = {
  name: "As it appears on the card",
  number: "1234 5678 9012 3456",
  expiry: "MM/YY",
  cvv: "3 or 4 digits",
} as const;

/**
 * What the update adds (section 6: "This adds {delta} to {patient}'s
 * estimate.").
 *
 * @param delta - The increase over what is held, shown.
 * @param patient - The patient's name.
 * @returns The sentence.
 */
export function updateAdds(delta: string, patient: string): string {
  return `This adds ${delta} to ${patient}'s estimate.`;
}

/** The owner's "no" to an update (section 6). */
export const DONT_GO_AHEAD = "Don't go ahead";

/** Under "Don't go ahead" (section 6). */
export const PRACTICE_WILL_CALL = "The practice will call you to talk it through.";

/** Above the lines an update adds: this unit's wording. */
export const ADDED_LABEL = "What this adds";

/**
 * Once the owner declined the update: this unit's wording.
 *
 * @param held - What stays held, shown.
 * @returns The sentence.
 */
export function updateDeclined(held: string): string {
  return `You said not to go ahead. ${PRACTICE_WILL_CALL} The ${held} already held stays as it is.`;
}

/**
 * A link to an estimate a newer one replaced, never authorised: this unit's
 * wording.
 *
 * @param practice - The practice's name.
 * @returns The sentence.
 */
export function linkReplaced(practice: string): string {
  return `This estimate has been replaced by a newer one. Ask ${practice} for its link.`;
}

/** The heading over a replaced estimate's notice: this unit's wording. */
export const REPLACED_HEADING = "There is a newer estimate";

/**
 * The receipt's first sentence (section 6: "You paid {amount} for
 * {patient}'s treatment. {released} of what was held has been released.");
 * the second is left out when nothing was released.
 *
 * @param paid - What the owner paid, shown.
 * @param patient - The patient's name.
 * @param released - What was released, shown, or null when nothing was.
 * @returns The sentence.
 */
export function receiptPaid(paid: string, patient: string, released: string | null): string {
  const first = `You paid ${paid} for ${patient}'s treatment.`;
  return released ? `${first} ${released} of what was held has been released.` : first;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

/**
 * What each approval paid (section 6: "Paid from your first approval: {a}.
 * Paid from your second approval: {b}."); one approval is "your approval",
 * and an approval nothing was taken from was released, never "paid from"
 * at nothing: this unit's wording (U6, U11), flagged.
 *
 * @param amounts - What each approval paid, shown, in the order they were given; null for nothing.
 * @returns The sentences.
 */
export function paidFromApprovals(amounts: readonly (string | null)[]): string {
  if (amounts.length === 1) {
    return amounts[0] === null
      ? "Nothing was taken from your approval: it was released."
      : `Paid from your approval: ${amounts[0]}.`;
  }
  return amounts
    .map((amount, at) => {
      const which = `your ${ORDINALS[at] ?? `number ${at + 1}`} approval`;
      return amount === null
        ? `Nothing was taken from ${which}: it was released.`
        : `Paid from ${which}: ${amount}.`;
    })
    .join(" ");
}

/**
 * Under the receipt (section 6, flagged there: the timing of a release on a
 * buyer's statement is not in the pages read, so the sentence is general).
 */
export const RELEASE_TIMING =
  "Released holds can take a few days to disappear from your statement.";

/**
 * A refund after discharge: this unit's wording (section 6 drafts none).
 *
 * @param charged - What was captured at discharge, shown.
 * @param refunded - What was refunded, shown.
 * @returns The sentence.
 */
export function refundedNote(charged: string, refunded: string): string {
  return `That is ${charged} charged at discharge, less ${refunded} refunded to you.`;
}

/**
 * The receipt's heading: this unit's wording.
 *
 * @param patient - The patient's name.
 * @param practice - The practice's name.
 * @returns The heading.
 */
export function receiptHeading(patient: string, practice: string): string {
  return `${patient}'s receipt from ${practice}`;
}

/** Above the bill's lines (section 6's discharge heading). */
export const BILL_LABEL = "Itemised bill";

/** The bill's total row: this unit's wording. */
export const BILL_TOTAL = "Total";

/**
 * Under a bill line done more than once: this unit's wording.
 *
 * @param quantity - How many were done.
 * @param unit - The price of one, shown.
 * @returns The line.
 */
export function billQuantity(quantity: number, unit: string): string {
  return `${quantity} at ${unit} each`;
}

/**
 * The heading of an update the owner has answered (approved or declined):
 * section 6's heading, told in the past once the asking is over. This unit's
 * wording (U11), flagged.
 *
 * @param vet - Who the vet is, as the page names them, capitalised.
 * @returns The heading.
 */
export function answeredUpdateHeading(vet: string): string {
  return `${vet} found something and asked before going ahead.`;
}

/** A withdrawn estimate's link: its heading. This unit's wording (U11), flagged. */
export const ESTIMATE_WITHDRAWN_HEADING = "This estimate was withdrawn";

/**
 * A withdrawn estimate's link: nothing to authorise, nothing charged. This
 * unit's wording (U11), flagged.
 *
 * @param practice - The practice's name.
 * @returns The sentence.
 */
export function estimateWithdrawn(practice: string): string {
  return `${practice} withdrew this estimate, so there is nothing to authorise and nothing has been charged. Ask them if you'd like it sent again.`;
}

/** A withdrawn update's link: its heading. This unit's wording (U11), flagged. */
export const UPDATE_WITHDRAWN_HEADING = "This update was withdrawn";

/**
 * A withdrawn update's link: nothing to approve; what was held stays. This
 * unit's wording (U11), flagged.
 *
 * @param practice - The practice's name.
 * @returns The sentence.
 */
export function updateWithdrawn(practice: string): string {
  return `${practice} withdrew this update, so there is nothing to approve. What you authorised before stays as it was.`;
}

/**
 * "Don't go ahead" that did not reach pawhold: declining asks nothing of
 * PayPal, so section 6's PayPal error is not its words. This unit's wording
 * (U11), flagged.
 */
export const DECLINE_FAILED = "That didn't go through, so nothing has changed. Try again.";

/** An owner's page that failed to render: its heading. This unit's wording (U11), flagged. */
export const OWNER_PAGE_FAILED_HEADING = "This page couldn't load";

/** An owner's page that failed to render. This unit's wording (U11), flagged. */
export const OWNER_PAGE_FAILED =
  "Nothing has been charged. Try again in a moment, or ask the practice that sent you the link.";

/** The button that renders a failed page again. */
export const TRY_AGAIN = "Try again";
