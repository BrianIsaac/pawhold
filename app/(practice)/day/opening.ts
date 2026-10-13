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
interface Span {
  readonly start: number;
  readonly end: number;
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
  const start = uncut(Math.max(1, line - LEAD_COLUMNS), bookings);
  const intoHour = (start - 1) % HOUR_COLUMNS;
  const roomy = start - Math.max(0, intoHour - (HOUR_COLUMNS - LABEL_COLUMNS));
  return bookings.some((one) => one.start < roomy && one.end > roomy) ? start : roomy;
}

/**
 * Where the grid opens in a scroller that may end before it: late in the
 * day, the view cannot start at its opening line, and a scroller stopped at
 * its end would start the view part way into a column, and maybe part way
 * into a booking under the room names. The view then opens at the last
 * whole line the scroller reaches, moved back to the start of any booking
 * that would open cut, so every booking in view is whole however late it is.
 *
 * @param line - The grid line the view would open at (`openingLine`'s).
 * @param lastLine - The line the view starts at with the scroller at its end; a fraction part way into a column.
 * @param bookings - Every booking's span.
 * @returns The grid line the view starts at.
 */
export function reachableLine(line: number, lastLine: number, bookings: readonly Span[]): number {
  return line <= lastLine ? line : uncut(Math.max(1, Math.floor(lastLine)), bookings);
}

/**
 * A grid line moved back to the start of any booking it would cut, and of
 * any booking that cuts that, until none does.
 *
 * @param line - The grid line.
 * @param bookings - Every booking's span.
 * @returns The line, or the earliest start it was moved back to.
 */
function uncut(line: number, bookings: readonly Span[]): number {
  let start = line;
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
