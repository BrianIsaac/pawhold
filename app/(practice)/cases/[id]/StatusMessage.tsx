"use client";

import { useEffect, useRef } from "react";

import styles from "./case.module.css";

/**
 * A confirmation shown once a page has moved on (sent, withdrawn): a status
 * that takes focus when it appears, so a screen reader reads it and the
 * keyboard starts from it rather than from the top of the page.
 *
 * @param props - The words.
 * @param props.children - The confirmation.
 * @returns The status.
 */
export function StatusMessage({ children }: { children: string }) {
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    status.current?.focus();
  }, [children]);
  return (
    <p ref={status} role="status" tabIndex={-1} className={styles.status}>
      {children}
    </p>
  );
}
