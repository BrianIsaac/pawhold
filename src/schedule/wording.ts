/**
 * The practice's day in section 6's words (D11, built as drafted and
 * flagged). Section 6 drafts the hold as a question ("Hold theatre 1 at
 * {time}? ..." with "Hold the slot"); D9 (a) has the hold apply at once, so
 * its second sentence is the hold's reason and the applied hold's words are
 * section 6's "Held by pawhold at {time}: waiting for approval. Undo".
 */

/**
 * Why the agent held a slot: section 6's second sentence of the hold.
 *
 * @param ownerFirstName - The owner's first name.
 * @param patientName - The patient.
 * @returns The reason.
 */
export function holdReason(ownerFirstName: string, patientName: string): string {
  return `${ownerFirstName} hasn't approved the update for ${patientName}.`;
}

/**
 * The applied hold, on the booking (section 6), without its "Undo" button.
 *
 * @param heldAt - When it was held, in the practice's clock ("13:35").
 * @returns The words.
 */
export function heldNote(heldAt: string): string {
  return `Held by pawhold at ${heldAt}: waiting for approval.`;
}

/**
 * The proposed move (section 6), asked of the practice.
 *
 * @param nextPatientName - The patient whose procedure would move.
 * @param time - Where it would move to, in the practice's clock ("14:05").
 * @param patientName - The patient whose update is waiting.
 * @returns The question.
 */
export function moveQuestion(nextPatientName: string, time: string, patientName: string): string {
  return `Move ${nextPatientName}'s procedure to ${time}, after ${patientName}'s update is answered?`;
}

/** Section 6's buttons: the move's two, and the hold's one. */
export const DAY_BUTTONS = {
  move: "Move it",
  dismiss: "Dismiss",
  undo: "Undo",
} as const;
