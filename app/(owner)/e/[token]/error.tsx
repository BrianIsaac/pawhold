"use client";

import { TRY_AGAIN, OWNER_PAGE_FAILED, OWNER_PAGE_FAILED_HEADING } from "@/owner/wording";

import styles from "./page.module.css";

/**
 * An owner's page that failed to render (U11; this unit's words, D11): says
 * nothing was charged and offers to try again.
 *
 * @param props - What failed and how to try again.
 * @param props.error - The error (its digest is in the server's log).
 * @param props.reset - Renders the page again.
 * @returns The page.
 */
export default function OwnerError({
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <section className={styles.notice} aria-labelledby="notice-heading">
      <h1 id="notice-heading">{OWNER_PAGE_FAILED_HEADING}</h1>
      <p>{OWNER_PAGE_FAILED}</p>
      <button type="button" className={styles.retry} onClick={reset}>
        {TRY_AGAIN}
      </button>
    </section>
  );
}
