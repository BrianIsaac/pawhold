import type { DayView } from "@/schedule/day";

/** How many five-minute columns to keep in view before the line scrolled to: ten minutes. */
export const LEAD_COLUMNS = 2;

/** The five-minute columns of an hour. */
const HOUR_COLUMNS = 12;

/**
 * How many five-minute columns of its first hour the view keeps at least:
 * fifteen minutes, which is room for the hour's label beside the room names.
 */
export const LABEL_COLUMNS = 3;

/** A booking's span on the grid, by its lines (the first is 1). */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Every booking's span on the day's grid.
 *
 * @param view - The day.
 * @returns The spans, room by room.
 */
export function bookingSpans(view: DayView): Span[] {
  return view.rooms.flatMap((lane) => lane.bookings.map((one) => one.column));
}

/**
 * Where the grid opens: the lead columns before the line to bring into view,
 * moved back to the start of any booking that would otherwise open cut
 * under the room names, so every booking in view is whole (U11); then, where
 * that cuts no booking, moved back off the last ten minutes of an hour, so
 * the first hour in view has room for its label (U8b). The grid's first line
 * is an hour's start.
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
  const intoHour = (start - 1) % HOUR_COLUMNS;
  const roomy = start - Math.max(0, intoHour - (HOUR_COLUMNS - LABEL_COLUMNS));
  return bookings.some((one) => one.start < roomy && one.end > roomy) ? start : roomy;
}

/**
 * The last grid line a scroller can bring to the room names: its scroll
 * stops where the grid's end meets the view's.
 *
 * @param scroller - Its widths in pixels.
 * @param scroller.scrollWidth - The whole grid's, with the room names.
 * @param scroller.clientWidth - The view's.
 * @param scroller.slotPx - A five-minute column's.
 * @returns The grid line (the first is 1).
 */
export function lastStartLine(scroller: {
  scrollWidth: number;
  clientWidth: number;
  slotPx: number;
}): number {
  const furthest = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  // A part of a pixel is the browser's rounding, not a column.
  return Math.floor(furthest / scroller.slotPx + 1e-6) + 1;
}

/**
 * Where the grid opens in a view that cannot scroll as far as the opening
 * asks: late in the day the grid ends within a view's width of it, the
 * browser stops the scroll at the grid's end, and a booking would open cut
 * under the room names. The opening is then worked out again, by the same
 * rule, from the last line the view can start at.
 *
 * @param line - The opening line (`openingLine`'s).
 * @param lastStart - The last line the view can start at (`lastStartLine`'s).
 * @param bookings - Every booking's span.
 * @returns The grid line the view starts at.
 */
export function reachableOpening(
  line: number,
  lastStart: number,
  bookings: readonly Span[],
): number {
  return line <= lastStart ? line : openingLine(lastStart + LEAD_COLUMNS, bookings);
}

/**
 * Where the board stands, scrolled, when it takes over from the plain
 * timeline (U8b): its own opening, unless the practice has scrolled the
 * plain timeline, whose place it then takes. The plain timeline says where
 * it opened itself (`ScrollIntoDay`'s mark); it may not have opened at all
 * when the Scheduler is the first to arrive, and then stands at the day's
 * start, which is no place the practice chose.
 *
 * @param places - The plain timeline's scroll, where it opened itself, and the board's own opening.
 * @param places.plainScroll - The plain timeline's scroll, in pixels.
 * @param places.plainOpenedAt - The scroll the plain timeline opened itself at, or null when it has not opened.
 * @param places.ownOpening - The board's own opening scroll.
 * @returns The scroll the board takes.
 */
export function takeOverScroll(places: {
  plainScroll: number;
  plainOpenedAt: number | null;
  ownOpening: number;
}): number {
  return places.plainScroll === (places.plainOpenedAt ?? 0)
    ? places.ownOpening
    : places.plainScroll;
}
