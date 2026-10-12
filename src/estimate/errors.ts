/** Why an estimate operation was refused. */
export type EstimateRefusal =
  | "request_invalid"
  | "case_not_found"
  | "version_not_found"
  | "no_price_list"
  | "currency_mismatch"
  | "draft_exists"
  | "sent"
  | "empty"
  | "different_cases"
  | "too_large"
  | "price_list_changed"
  | "lines_refused";

/** A refused line: its place (the first is 1), its code as given, and why. */
export interface EstimateLineIssue {
  readonly line: number;
  readonly code: string | null;
  readonly message: string;
}

/** An estimate operation refused, with the reason and, for lines, each fault. */
export class EstimateError extends Error {
  override readonly name = "EstimateError";

  /**
   * @param reason - Why, as a stable word a caller can branch on.
   * @param message - Why, in words.
   * @param issues - For refused lines, each fault.
   */
  constructor(
    readonly reason: EstimateRefusal,
    message: string,
    readonly issues: readonly EstimateLineIssue[] = [],
  ) {
    super(message);
  }
}
