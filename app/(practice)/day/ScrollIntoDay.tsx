"use client";

import { useEffect, useRef } from "react";

import { reachableLine } from "./opening";

/**
 * Scrolls the day's grid sideways, once for each day shown (never again when
 * the minute's check shows the same day afresh, so a practice that scrolled
 * stays where it scrolled), so the line it is given (the page's
 * `openingLine`) is the first just in from the room names, or, late in the
 * day, the last line the grid reaches that cuts no booking.
 *
 * @param props - The scroller's id, the day, the grid line, how many columns the grid has, and its bookings.
 * @param props.scrollerId - The scroller's element id.
 * @param props.day - The day shown.
 * @param props.line - The grid line the view starts at (the first is 1).
 * @param props.slots - The grid's five-minute columns.
 * @param props.bookings - Every booking's span on the grid.
 * @returns Nothing drawn.
 */
export function ScrollIntoDay({
  scrollerId,
  day,
  line,
  slots,
  bookings,
}: {
  scrollerId: string;
  day: string;
  line: number;
  slots: number;
  bookings: readonly { readonly start: number; readonly end: number }[];
}) {
  const scrolledDay = useRef<string | null>(null);
  useEffect(() => {
    if (scrolledDay.current === day) {
      return;
    }
    const scroller = document.getElementById(scrollerId);
    const label = scroller?.querySelector<HTMLElement>("[data-room-label]");
    if (!scroller || !label) {
      return;
    }
    const slot = (scroller.scrollWidth - label.offsetWidth) / slots;
    const lastLine = 1 + (scroller.scrollWidth - scroller.clientWidth) / slot;
    scroller.scrollLeft = Math.max(0, (reachableLine(line, lastLine, bookings) - 1) * slot);
    // Where it opened, for the board: a scroll that differs from this is the practice's own.
    scroller.dataset.openedAt = String(scroller.scrollLeft);
    scrolledDay.current = day;
    // The bookings are read once, with the day: a minute's check of the same day never scrolls again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollerId, day, line, slots]);
  return null;
}
