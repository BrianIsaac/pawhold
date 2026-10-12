import { linkExpired } from "@/owner/wording";

import styles from "./page.module.css";

/**
 * The page an expired or changed owner's link opens (section 6).
 *
 * @param props - The practice to ask.
 * @param props.practiceName - The practice, when the link names one it can trust.
 * @returns The page.
 */
export function AskThePractice({ practiceName }: { readonly practiceName: string | null }) {
  return (
    <section className={styles.notice} aria-labelledby="ask-the-practice">
      <h1 id="ask-the-practice">This link has expired</h1>
      <p>{linkExpired(practiceName)}</p>
    </section>
  );
}
