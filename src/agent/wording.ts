/**
 * The words the screens show for what the agent drafted, as plan section 6
 * drafts them. Every string is a draft and the operator's to change (D11);
 * the one section 6 does not draft (a line left out as unsupported) is this
 * unit's and is flagged in the handover.
 */

/**
 * Under a drafted line, in grey: the notes it came from (section 6).
 *
 * @param span - The line's span, as the notes wrote it.
 * @returns The sentence.
 */
export function fromYourNotes(span: string): string {
  return `From your notes: "${span}"`;
}

/**
 * Under a drafted line that depends on a finding (section 6).
 *
 * @param finding - What the line depends on.
 * @returns The sentence.
 */
export function onlyIf(finding: string): string {
  return `Only if: ${finding}`;
}

/**
 * A span no price list item matched (section 6).
 *
 * @param span - The span.
 * @returns The sentence.
 */
export function noItemMatched(span: string): string {
  return `No price list item matched "${span}". Add an item by hand or leave it out.`;
}

/** The model's failure, above an empty estimate (section 6). */
export const DRAFT_FAILED =
  "The draft didn't work this time. Add items from your price list below.";

/**
 * A line the draft quoted from words the notes do not hold, left out (plan
 * 3.4: "shown as unsupported"). Not drafted in section 6: this unit's wording.
 *
 * @param span - What the draft quoted.
 * @returns The sentence.
 */
export function leftOutUnsupported(span: string): string {
  return `Left out: the draft quoted "${span}", which is not in your notes.`;
}

/**
 * The owner's update page heading (section 6).
 *
 * @param vetName - The vet's name.
 * @returns The heading.
 */
export function updateHeading(vetName: string): string {
  return `${vetName} found something and is asking before going ahead.`;
}

/** Above the vet's own words on the owner's update page (section 6). */
export const WHAT_THE_VET_WROTE = "What the vet wrote";
