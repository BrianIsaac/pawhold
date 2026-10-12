/**
 * The words the owner's pages show, as plan section 6 drafts them. Every
 * string is a draft and the operator's to change (D11); where section 6 has
 * no draft for a case the page meets, the wording is this unit's and is
 * flagged in the handover.
 */

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
