"use client";

import { useEffect, useRef } from "react";

/**
 * Scrolls the day's grid sideways, once for each day shown (never again when
 * the minute's check shows the same day afresh, so a practice that scrolled
 * stays where it scrolled), so the line it is given (the page's
 * `openingLine`) is the first just in from the room names.
 *
 * @param props - The scroller's id, the day, the grid line and how many columns the grid has.
 * @param props.scrollerId - The scroller's element id.
 * @param props.day - The day shown.
 * @param props.line - The grid line the view starts at (the first is 1).
 * @param props.slots - The grid's five-minute columns.
 * @returns Nothing drawn.
 */
export function ScrollIntoDay({
  scrollerId,
  day,
  line,
  slots,
}: {
  scrollerId: string;
  day: string;
  line: number;
  slots: number;
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
    scroller.scrollLeft = Math.max(0, (line - 1) * slot);
    // Where it opened, for the board: a scroll that differs from this is the practice's own.
    scroller.dataset.openedAt = String(scroller.scrollLeft);
    scrolledDay.current = day;
  }, [scrollerId, day, line, slots]);
  return null;
}
