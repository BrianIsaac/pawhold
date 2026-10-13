import type { ReactNode } from "react";

import { Disc } from "./Drawing";
import styles from "./EmptyState.module.css";

/**
 * Nothing to show yet: a drawing on a large mint disc above the words that
 * say so (the restyle's mock-ups draw one for Today's cases and the day).
 *
 * @param props - The drawing and the words.
 * @param props.figure - The drawing.
 * @param props.children - What is empty, and what to do about it.
 * @returns The empty state.
 */
export function EmptyState({
  figure,
  children,
}: {
  readonly figure: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <Disc size="large">{figure}</Disc>
      <p className={styles.words}>{children}</p>
    </div>
  );
}
