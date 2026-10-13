import type { ReactNode } from "react";

import { updateHeading, WHAT_THE_VET_WROTE } from "@/agent/wording";
import { formatPence } from "@/money/format";
import type { OwnerUpdatePage } from "@/owner/view";
import {
  ADDED_LABEL,
  answeredUpdateHeading,
  capitalised,
  updateAdds,
  vetCalled,
} from "@/owner/wording";

import { OwnerLines } from "./lines";
import styles from "./page.module.css";

/**
 * An update the owner is asked to approve (section 6): the vet asking
 * first, U4's explanation when code passed it, then what the vet wrote in
 * full and the photo if they shared it (U11), what the update adds in the
 * owner's words with the vet's own words behind each line, and what it adds
 * over what is held; then the way to approve it, and "Don't go ahead".
 *
 * @param props - The page and its answers.
 * @param props.page - The update.
 * @param props.answer - PayPal's buttons and card fields with "Don't go ahead", the hold, or the decline.
 * @param props.answered - Whether the owner has answered it, so the heading tells it in the past.
 * @param props.photoSrc - Where the photo the vet shared is served, when they shared one.
 * @returns The page.
 */
export function Update({
  page,
  answer,
  answered,
  photoSrc,
}: {
  readonly page: OwnerUpdatePage;
  readonly answer?: ReactNode;
  readonly answered: boolean;
  readonly photoSrc: string;
}) {
  const delta = formatPence(page.increasePence, page.currency);
  const vet = capitalised(vetCalled(page.header.vetName));
  return (
    <article className={styles.page} aria-labelledby="update-heading">
      <header className={styles.header}>
        <p className={styles.eyebrow}>{page.header.practiceName}</p>
        <h1 id="update-heading">{answered ? answeredUpdateHeading(vet) : updateHeading(vet)}</h1>
        {page.explanation ? <p className={styles.explanation}>{page.explanation}</p> : null}
      </header>

      {page.finding ? (
        <section className={styles.finding} aria-labelledby="finding-heading">
          <h2 id="finding-heading">{WHAT_THE_VET_WROTE}</h2>
          <blockquote>{page.finding}</blockquote>
          {page.photoShared ? (
            <figure className={styles.photo}>
              {/* The vet's own photo, served by the link's photo route; not a next/image source. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoSrc} alt={`The photo ${vet} added for ${page.header.patientName}`} />
            </figure>
          ) : null}
        </section>
      ) : null}

      <OwnerLines lines={page.added} currency={page.currency} label={ADDED_LABEL} id="added" />

      <p className={styles.range}>{updateAdds(delta, page.header.patientName)}</p>

      {answer ? <section className={styles.authorise}>{answer}</section> : null}
    </article>
  );
}
