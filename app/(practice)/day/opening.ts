/** How many five-minute columns to keep in view before the line scrolled to: ten minutes. */
export const LEAD_COLUMNS = 2;

/** A booking's span on the grid, by its lines (the first is 1). */
interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Where the grid opens: the lead columns before the line to bring into view,
 * moved back to the start of any booking that would otherwise open cut
 * under the room names, so every booking in view is whole (U11).
 *
 * @param line - The grid line to bring into view (the first is 1).
 * @param bookings - Every booking's span.
 * @returns The grid line the view starts at.
 */
export function openingLine(line: number, bookings: readonly Span[]): number {
  let start = Math.max(1, line - LEAD_COLUMNS);
  for (let moved = true; moved;) {
    moved = false;
    for (const one of bookings) {
      if (one.start < start && one.end > start) {
        start = one.start;
        moved = true;
      }
    }
  }
  return start;
}
