import type { ReactNode } from "react";

import styles from "./StatePanel.module.css";

/**
 * A page in place of the one asked for (U11): something failed, or there is
 * nothing there. A heading, one sentence, and the way to go on.
 *
 * @param props - What it says and offers.
 * @param props.heading - The heading.
 * @param props.text - The sentence.
 * @param props.children - The way on: a button, a link or both.
 * @returns The panel.
 */
export function StatePanel({
  heading,
  text,
  children,
}: {
  readonly heading: string;
  readonly text: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={styles.panel} aria-labelledby="state-heading">
      <h1 id="state-heading" className={styles.heading}>
        {heading}
      </h1>
      <p className={styles.text}>{text}</p>
      <div className={styles.actions}>{children}</div>
    </section>
  );
}
