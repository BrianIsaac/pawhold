"use client";

import { useEffect } from "react";

/** How many five-minute columns to keep in view before the line scrolled to: ten minutes. */
export const LEAD_COLUMNS = 2;

/**
 * Scrolls the day's grid sideways, once on opening, so the line it is given
 * sits just in from the room names.
 *
 * @param props - The scroller's id, the grid line and how many columns the grid has.
 * @param props.scrollerId - The scroller's element id.
 * @param props.line - The grid line to bring into view (the first is 1).
 * @param props.slots - The grid's five-minute columns.
 * @returns Nothing drawn.
 */
export function ScrollIntoDay({
  scrollerId,
  line,
  slots,
}: {
  scrollerId: string;
  line: number;
  slots: number;
}) {
  useEffect(() => {
    const scroller = document.getElementById(scrollerId);
    const label = scroller?.querySelector<HTMLElement>("[data-room-label]");
    if (!scroller || !label) {
      return;
    }
    const slot = (scroller.scrollWidth - label.offsetWidth) / slots;
    scroller.scrollLeft = Math.max(0, (line - 1 - LEAD_COLUMNS) * slot);
  }, [scrollerId, line, slots]);
  return null;
}
