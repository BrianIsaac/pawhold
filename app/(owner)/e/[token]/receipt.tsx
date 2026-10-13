import { formatPence } from "@/money/format";
import type { OwnerReceiptPage } from "@/owner/view";
import {
  BILL_LABEL,
  BILL_TOTAL,
  billQuantity,
  paidFromApprovals,
  receiptHeading,
  receiptPaid,
  refundedNote,
  RELEASE_TIMING,
} from "@/owner/wording";
import { withSpecies } from "@/practice/species";

import styles from "./page.module.css";

/**
 * The receipt after discharge (section 6): what the owner paid and what was
 * released, the bill's lines, what each approval paid, and any refund.
 *
 * @param props - The receipt.
 * @param props.page - The receipt's page.
 * @returns The page.
 */
export function Receipt({ page }: { readonly page: OwnerReceiptPage }) {
  const money = (pence: number) => formatPence(pence, page.currency);
  const paid = page.chargedPence - page.refundedPence;
  return (
    <article className={styles.page} aria-labelledby="receipt-heading">
      <header className={styles.header}>
        <p className={styles.eyebrow}>
          {withSpecies(page.header.patientName, page.header.species)}
        </p>
        <h1 id="receipt-heading">
          {receiptHeading(page.header.patientName, page.header.practiceName)}
        </h1>
      </header>

      <div className={styles.range}>
        <p>
          {receiptPaid(
            money(paid),
            page.header.patientName,
            page.releasedPence > 0 ? money(page.releasedPence) : null,
          )}
        </p>
        {page.refundedPence > 0 ? (
          <p className={styles.rangeNote}>
            {refundedNote(money(page.chargedPence), money(page.refundedPence))}
          </p>
        ) : null}
      </div>

      {page.lines.length > 0 ? (
        <section className={styles.section} aria-labelledby="bill">
          <h2 id="bill" className={styles.sectionHeading}>
            {BILL_LABEL}
          </h2>
          <ul className={styles.lines} aria-label={BILL_LABEL}>
            {page.lines.map((line) => (
              <li key={line.position} className={styles.line}>
                <div className={styles.lineRow}>
                  <span className={styles.lineWording}>{line.wording}</span>
                  <span className={styles.linePrice}>{money(line.amountPence)}</span>
                </div>
                {line.quantity > 1 ? (
                  <p className={styles.onlyIf}>
                    {billQuantity(line.quantity, money(line.amountPence / line.quantity))}
                  </p>
                ) : null}
              </li>
            ))}
            <li className={`${styles.line} ${styles.total}`}>
              <div className={styles.lineRow}>
                <span className={styles.lineWording}>{BILL_TOTAL}</span>
                <span className={styles.linePrice}>{money(page.chargedPence)}</span>
              </div>
            </li>
          </ul>
        </section>
      ) : null}

      <p className={styles.explanation}>
        {paidFromApprovals(
          page.approvals.map((one) => (one.capturedPence > 0 ? money(one.capturedPence) : null)),
        )}
      </p>

      {page.releasedPence > 0 ? <p className={styles.askFirst}>{RELEASE_TIMING}</p> : null}
    </article>
  );
}
