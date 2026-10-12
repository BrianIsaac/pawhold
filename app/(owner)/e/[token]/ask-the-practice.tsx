import { askToSendAgain, LINK_EXPIRED } from "@/owner/wording";

import styles from "./page.module.css";

/**
 * A notice in place of the page: a heading and one sentence.
 *
 * @param props - What it says.
 * @param props.heading - The heading.
 * @param props.text - The sentence.
 * @returns The notice.
 */
export function Notice({ heading, text }: { readonly heading: string; readonly text: string }) {
  return (
    <section className={styles.notice} aria-labelledby="notice-heading">
      <h1 id="notice-heading">{heading}</h1>
      <p>{text}</p>
    </section>
  );
}

/**
 * The page an expired or changed owner's link opens (section 6).
 *
 * @param props - The practice to ask.
 * @param props.practiceName - The practice, when the link names one it can trust.
 * @returns The page.
 */
export function AskThePractice({ practiceName }: { readonly practiceName: string | null }) {
  return <Notice heading={LINK_EXPIRED} text={askToSendAgain(practiceName)} />;
}
