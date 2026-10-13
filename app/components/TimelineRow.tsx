import styles from "./TimelineRow.module.css";

/** One fact of the raw event shown behind the disclosure. */
export interface TimelineDetail {
  readonly term: string;
  readonly value: string;
}

/** A timeline row's props. */
export interface TimelineRowProps {
  /** When it happened, as an ISO 8601 instant. */
  readonly at: string;
  /** When it happened, as the practice reads it ("14:02"). */
  readonly time: string;
  /** Who acted ("Owner", "PayPal"). */
  readonly who: string;
  /** What happened, in plain words. */
  readonly what: string;
  /** The raw event: PayPal's ids, the model's, the states. */
  readonly details: readonly TimelineDetail[];
  /** A word on the event itself, such as that it was seeded (D16). */
  readonly note?: string;
}

/**
 * One event of a case's timeline, in section 6's one line ("{time} {who}:
 * {what}") with the raw event behind "Show PayPal and model details".
 *
 * @param props - The time, who, what, the raw details and any note.
 * @returns The row.
 */
export function TimelineRow({ at, time, who, what, details, note }: TimelineRowProps) {
  return (
    <li className={styles.row}>
      <p className={styles.line}>
        <time dateTime={at} className={styles.time}>
          {time}
        </time>{" "}
        <span>
          {who}: {what}
        </span>
        {note === undefined ? null : (
          <>
            {" "}
            <span className={styles.note}>{note}</span>
          </>
        )}
      </p>
      {details.length === 0 ? null : (
        <details className={styles.details}>
          <summary className={styles.summary}>Show PayPal and model details</summary>
          <dl className={styles.facts}>
            {details.map((detail) => (
              <div key={detail.term} className={styles.fact}>
                <dt className={styles.term}>{detail.term}</dt>
                <dd className={styles.value}>{detail.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </li>
  );
}
