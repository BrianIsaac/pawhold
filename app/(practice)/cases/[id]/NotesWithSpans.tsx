import { highlightSegments, type LineSpan } from "@/practice/highlight";

import styles from "./case.module.css";

/**
 * The vet's words with each drafted line's span highlighted where it sits,
 * numbered as the lines are.
 *
 * @param props - The words and the spans.
 * @param props.text - The notes or the finding.
 * @param props.spans - Each line's span.
 * @returns The words.
 */
export function NotesWithSpans({ text, spans }: { text: string; spans: readonly LineSpan[] }) {
  return (
    <p className={styles.notes}>
      {highlightSegments(text, spans).map((segment, at) =>
        segment.positions.length === 0 ? (
          <span key={at}>{segment.text}</span>
        ) : (
          <mark key={at} className={styles.mark}>
            {segment.text}
            <span className={styles.markNumber} aria-hidden="true">
              {segment.positions.join(", ")}
            </span>
          </mark>
        ),
      )}
    </p>
  );
}
