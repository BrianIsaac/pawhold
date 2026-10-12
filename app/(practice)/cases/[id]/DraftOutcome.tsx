import { DRAFT_FAILED, leftOutUnsupported, noItemMatched } from "@/agent/wording";
import type { SourceView } from "@/practice/sources";

import styles from "./case.module.css";

/**
 * What the draft could not put on the estimate: section 6's sentence for each
 * span no item matched, U4's for each line left out, and section 6's words
 * when the model failed.
 *
 * @param props - The draft's source.
 * @param props.source - The words it was drafted from and what it made of them.
 * @returns The notices, or nothing.
 */
export function DraftOutcome({ source }: { source: SourceView | null }) {
  if (!source) {
    return null;
  }
  const notices = [
    ...source.unmatched.map((one) => noItemMatched(one.notesSpan)),
    ...source.unsupported
      .filter((one) => one.notesSpan !== null)
      .map((one) => leftOutUnsupported(one.notesSpan!)),
  ];
  return (
    <>
      {source.failure ? (
        <p role="status" className={styles.notice}>
          {DRAFT_FAILED}
        </p>
      ) : null}
      {notices.length === 0 ? null : (
        <ul className={styles.noticeList} aria-label="From your notes, not on the estimate">
          {notices.map((notice) => (
            <li key={notice} className={styles.notice}>
              {notice}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
