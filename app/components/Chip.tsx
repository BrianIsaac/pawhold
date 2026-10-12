import type { ReactNode } from "react";

import styles from "./Chip.module.css";

/**
 * A chip's tone: each money state of plan 3.2, and the two flags a hold
 * carries beside its case's chip (extended, honour period over).
 */
export const CHIP_TONES = [
  "estimate_draft",
  "awaiting_owner",
  "held",
  "update_awaiting_owner",
  "update_declined",
  "captured",
  "released",
  "refunded",
  "withdrawn",
  "extended",
  "honour_period_over",
] as const;

export type ChipTone = (typeof CHIP_TONES)[number];

/** A chip's props. */
export interface ChipProps {
  readonly tone: ChipTone;
  readonly children: ReactNode;
}

/**
 * A money chip in the board's colours (section 6). Its words carry its
 * meaning; the colour only repeats it.
 *
 * @param props - The tone and the label.
 * @returns The chip.
 */
export function Chip({ tone, children }: ChipProps) {
  return (
    <span className={styles.chip} data-tone={tone}>
      {children}
    </span>
  );
}
