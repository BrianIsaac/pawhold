/**
 * The words the owner's pages show, as plan section 6 drafts them. Every
 * string is a draft and the operator's to change (D11); where section 6 has
 * no draft for a case the page meets, the wording is this unit's and is
 * flagged in the handover. Money arrives already shown by code
 * (`formatPence`), never written here.
 */

/**
 * Who section 6's "{vet name}" is on the owner's pages: no vet's name is
 * kept on a case or a version (U1's, U2's and U3's shapes carry none), so the
 * pages say "your vet". Flagged in the handover.
 */
export const YOUR_VET = "your vet";

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
 * An expired or changed link (section 6: "This link has expired. Ask
 * {practice} to send it again."). A changed link names no practice anyone
 * can trust, so it asks the practice by no name: this unit's wording.
 *
 * @param practiceName - The practice, when the link's signature holds.
 * @returns The sentence.
 */
export function linkExpired(practiceName: string | null): string {
  return `This link has expired. Ask ${practiceName ?? "the practice that sent it"} to send it again.`;
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
 * The estimate's range (section 6).
 *
 * @param vet - Who the vet is, as the page names them.
 * @param low - The bottom of the range, shown.
 * @param high - The top of the range, shown.
 * @returns The sentence.
 */
export function rangeLine(vet: string, low: string, high: string): string {
  return `Likely ${low} to ${high}, depending on what ${vet} finds.`;
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
