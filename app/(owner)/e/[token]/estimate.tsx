import type { ReactNode } from "react";

import { formatPence } from "@/money/format";
import type { OwnerEstimatePage } from "@/owner/view";
import {
  askFirst,
  estimateHeading,
  estimateIntro,
  LINES_LABEL,
  rangeLine,
  vetCalled,
} from "@/owner/wording";
import { withSpecies } from "@/practice/species";

import { OwnerLines } from "./lines";
import styles from "./page.module.css";

/**
 * The estimate the owner is asked to authorise (section 6): the lines in the
 * owner's words beside the vet's notes, the range, what is held and why,
 * then the way to authorise it.
 *
 * @param props - The page and the way to authorise.
 * @param props.page - The estimate.
 * @param props.authorise - PayPal's buttons and card fields, the hold, or what stands in their place.
 * @returns The page.
 */
export function Estimate({
  page,
  authorise,
}: {
  readonly page: OwnerEstimatePage;
  readonly authorise?: ReactNode;
}) {
  const money = (pence: number) => formatPence(pence, page.currency);
  const high = money(page.totals.highPence);
  const vet = vetCalled(page.header.vetName);
  return (
    <article className={styles.page} aria-labelledby="estimate-heading">
      <header className={styles.header}>
        <p className={styles.eyebrow}>
          {withSpecies(page.header.patientName, page.header.species)}
        </p>
        <h1 id="estimate-heading">
          {estimateHeading(page.header.patientName, page.header.practiceName)}
        </h1>
        <p className={styles.intro}>{estimateIntro(vet, page.header.patientName, high)}</p>
      </header>

      <p className={styles.range}>{rangeLine(vet, money(page.totals.lowPence), high)}</p>

      <OwnerLines lines={page.lines} currency={page.currency} label={LINES_LABEL} id="lines" />

      {authorise ? <section className={styles.authorise}>{authorise}</section> : null}

      <p className={styles.askFirst}>{askFirst(vet, high)}</p>
    </article>
  );
}
