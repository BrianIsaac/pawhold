import { WHAT_THE_VET_WROTE, onlyIf } from "@/agent/wording";
import type { CurrencyCode } from "@/money/currency";
import { formatPence } from "@/money/format";
import type { OwnerLine } from "@/owner/view";
import { linePrice } from "@/owner/wording";

import styles from "./page.module.css";

/**
 * Estimate lines as the owner reads them: the owner's wording and the price,
 * "Only if" where a line depends on a finding, and "What the vet wrote"
 * behind a disclosure (section 6).
 *
 * @param props - The lines and how they are named.
 * @param props.lines - The lines.
 * @param props.currency - Their currency.
 * @param props.label - The list's name, shown above it.
 * @param props.id - The heading's id.
 * @returns The list.
 */
export function OwnerLines({
  lines,
  currency,
  label,
  id,
}: {
  readonly lines: readonly OwnerLine[];
  readonly currency: CurrencyCode;
  readonly label: string;
  readonly id: string;
}) {
  const money = (pence: number) => formatPence(pence, currency);
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionHeading}>
        {label}
      </h2>
      <ul className={styles.lines} aria-label={label}>
        {lines.map((line) => (
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
  );
}
