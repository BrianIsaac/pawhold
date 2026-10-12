/** Why a schedule operation was refused. */
export type ScheduleRefusal =
  | "request_invalid"
  | "not_found"
  | "room_taken"
  | "vet_taken"
  | "proposal_not_found"
  | "hold_released"
  | "move_not_open"
  | "move_stale"
  | "move_too_late"
  | "move_clash";

/** A schedule operation refused: a stable reason to branch on, and why in words a person reads. */
export class ScheduleError extends Error {
  override readonly name = "ScheduleError";

  /**
   * @param reason - Why, as a stable word.
   * @param message - Why, in words a person reads.
   */
  constructor(
    readonly reason: ScheduleRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The exclusion constraint a refused statement broke, when it was one of the
 * schedule's (migration 0012), read through Drizzle's wrapping of the driver's error.
 *
 * @param error - What was thrown.
 * @returns `booking_room_free`, `booking_vet_free`, or null for anything else.
 */
export function brokenScheduleConstraint(
  error: unknown,
): "booking_room_free" | "booking_vet_free" | null {
  const raised = (error as { cause?: unknown } | null)?.cause ?? error;
  const { code, constraint_name: constraint } = (raised ?? {}) as {
    code?: string;
    constraint_name?: string;
  };
  if (code !== "23P01") {
    return null;
  }
  return constraint === "booking_room_free" || constraint === "booking_vet_free"
    ? constraint
    : null;
}
