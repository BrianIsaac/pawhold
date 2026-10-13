import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { fraunces } from "../fonts";
import styles from "./owner.module.css";

export const metadata: Metadata = {
  // An owner's link carries its token in the path: never indexed, and only
  // the origin goes with a request to another site (PayPal's SDK).
  robots: { index: false, follow: false },
  referrer: "strict-origin-when-cross-origin",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The owner's mint (--colour-mint): the phone's own bar meets the head of the page.
  themeColor: "#bbe1c3",
};

/**
 * The owner's pages: one column, sized for a phone, opened from the link the
 * practice sends.
 *
 * @param props - The page tree.
 * @param props.children - The page.
 * @returns The owner's shell.
 */
export default function OwnerLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className={`${styles.owner} ${fraunces.variable}`} data-owner-shell="">
      <main className={styles.column}>{children}</main>
    </div>
  );
}
