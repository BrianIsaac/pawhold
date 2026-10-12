/** Why a practice screen's request was refused. */
export type PracticeRefusal = "request_invalid" | "case_not_found" | "version_not_found" | "stale";

/** A practice screen's request refused, with the reason and, for a form, each field's fault. */
export class PracticeError extends Error {
  override readonly name = "PracticeError";

  /**
   * @param reason - Why, as a stable word.
   * @param message - Why, in words a person reads.
   * @param fields - Each faulty field's fault, by the field's name.
   */
  constructor(
    readonly reason: PracticeRefusal,
    message: string,
    readonly fields: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}
