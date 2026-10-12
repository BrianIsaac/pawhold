import type { CurrencyCode } from "@/money/currency";
import type { VersionPanel } from "@/practice/estimate";
import { fromYourNotes, onlyIf } from "@/agent/wording";
import { lineQuantity, linePrice } from "@/practice/wording";

import type { FormState } from "../../form-state";
import styles from "./case.module.css";
import { LineEditor } from "./LineEditor";

/** The bound actions that change one line, for a draft. */
export interface LineActions {
  readonly save: (previous: FormState, form: FormData) => Promise<FormState>;
  readonly remove: () => Promise<FormState>;
}

/**
 * A version's lines as section 6 drafts each: the item's name and code, the
 * quantity or range, the price; under it, in grey, "From your notes:
 * "{span}"" and "Only if: {finding}". Each is numbered as its span is in the
 * notes. A draft's lines can be changed or removed.
 *
 * @param props - The panel, its currency, the lines to show and, for a draft, each line's actions.
 * @param props.panel - The version and its source.
 * @param props.currency - The case's currency.
 * @param props.from - Show the lines from this index on (an update's added lines).
 * @param props.actions - For a draft, the bound actions of the line with each id.
 * @returns The lines.
 */
export function VersionLines({
  panel,
  currency,
  from = 0,
  actions,
}: {
  panel: VersionPanel;
  currency: CurrencyCode;
  from?: number;
  actions?: (lineId: string) => LineActions;
}) {
  return (
    <ol className={styles.lines} aria-label={`Lines of version ${panel.version.number}`}>
      {panel.version.lines.slice(from).map((line) => {
        const bound = actions?.(line.id);
        return (
          <li key={line.id} className={styles.line}>
            <div className={styles.lineHead}>
              <span className={styles.lineNumber} aria-hidden="true">
                {line.position}
              </span>
              <div>
                <p className={styles.lineName}>
                  {line.name}
                  <span className={styles.code}>{line.code}</span>
                </p>
                <p className={styles.lineQuantity}>{lineQuantity(line, currency)}</p>
              </div>
              <p className={styles.linePrice}>{linePrice(line, currency)}</p>
            </div>
            {line.notesSpan === null ? null : (
              <p className={styles.lineNote}>{fromYourNotes(line.notesSpan)}</p>
            )}
            {line.dependsOn === null ? null : (
              <p className={styles.lineNote}>{onlyIf(line.dependsOn)}</p>
            )}
            {line.ownerWording === null ? null : (
              <p className={styles.lineNote}>The owner reads: &quot;{line.ownerWording}&quot;</p>
            )}
            {bound ? <LineEditor line={line} save={bound.save} remove={bound.remove} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
