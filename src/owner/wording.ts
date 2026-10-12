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
