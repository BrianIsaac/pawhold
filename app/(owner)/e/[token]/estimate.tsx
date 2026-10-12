import type { ReactNode } from "react";

import { WHAT_THE_VET_WROTE, onlyIf } from "@/agent/wording";
import { formatPence } from "@/money/format";
import type { OwnerPage } from "@/owner/view";
import {
  askFirst,
  estimateHeading,
  estimateIntro,
  linePrice,
  LINES_LABEL,
  rangeLine,
  YOUR_VET,
} from "@/owner/wording";

import styles from "./page.module.css";

type EstimatePage = Extract<OwnerPage, { kind: "estimate" }>;

/**
 * The estimate the owner is asked to authorise (section 6): the lines in the
 * owner's words beside the vet's notes, the range, what is held and why,
 * then the way to authorise it.
 *
 * @param props - The page and the way to authorise.
 * @param props.page - The estimate.
 * @param props.authorise - PayPal's buttons and card fields, or what stands in their place.
 * @returns The page.
 */
export function Estimate({
  page,
  authorise,
}: {
  readonly page: EstimatePage;
  readonly authorise?: ReactNode;
}) {
  const money = (pence: number) => formatPence(pence, page.currency);
  const high = money(page.totals.highPence);
  return (
    <article className={styles.page} aria-labelledby="estimate-heading">
      <header className={styles.header}>
        <h1 id="estimate-heading">
          {estimateHeading(page.header.patientName, page.header.practiceName)}
        </h1>
        <p className={styles.intro}>{estimateIntro(YOUR_VET, page.header.patientName, high)}</p>
      </header>

      <p className={styles.range}>{rangeLine(YOUR_VET, money(page.totals.lowPence), high)}</p>

      <section className={styles.section} aria-labelledby="estimate-lines">
        <h2 id="estimate-lines" className={styles.sectionHeading}>
          {LINES_LABEL}
        </h2>
        <ul className={styles.lines} aria-label={LINES_LABEL}>
          {page.lines.map((line) => (
            <li key={line.position} className={styles.line}>
              <div className={styles.lineRow}>
                <span className={styles.lineWording}>{line.wording}</span>
                <span className={styles.linePrice}>
                  {linePrice(money(line.lowPence), money(line.highPence))}
                </span>
              </div>
              {line.dependsOn ? <p className={styles.onlyIf}>{onlyIf(line.dependsOn)}</p> : null}
              {line.notesSpan ? (
                <details className={styles.notes}>
                  <summary>{WHAT_THE_VET_WROTE}</summary>
                  <blockquote>{line.notesSpan}</blockquote>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {authorise ? <section className={styles.authorise}>{authorise}</section> : null}

      <p className={styles.askFirst}>{askFirst(YOUR_VET, high)}</p>
    </article>
  );
}
