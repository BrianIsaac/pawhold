"use client";

import { useLinkStatus } from "next/link";

import styles from "./LinkPending.module.css";

/**
 * A link's page on its way (U11): inside a `Link`, a bar along its foot
 * while Next fetches the page it opens, so a slow page never looks like
 * a click that did nothing. Hidden from assistive technology, which hears
 * the new page's title when it arrives (Next's route announcer). Without
 * JavaScript the browser's own loading shows instead; nothing streams a
 * fallback, so a page with no JavaScript, and a 404, stay whole.
 *
 * @returns The bar, drawn only while pending.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return <span className={styles.bar} data-pending={pending ? "" : undefined} aria-hidden="true" />;
}
