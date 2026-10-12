import type { TimelineRow as Row } from "@/practice/timeline";

import { TimelineRow } from "../../../components/TimelineRow";
import styles from "./case.module.css";

/**
 * The case's timeline (section 6): every event of its audit trail, newest
 * last, under the day it happened, each "{time} {who}: {what}" with the raw
 * event behind "Show PayPal and model details".
 *
 * @param props - The rows.
 * @param props.rows - The case's events in plain words, in order.
 * @returns The timeline.
 */
export function TimelineSection({ rows }: { rows: readonly Row[] }) {
  const days: { day: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const last = days.at(-1);
    if (last && last.day === row.day) {
      last.rows.push(row);
    } else {
      days.push({ day: row.day, rows: [row] });
    }
  }
  return (
    <div className={styles.panel}>
      {days.map((group, at) => (
        <div key={`${group.day}-${at}`} className={styles.timelineDay}>
          <h3 className={styles.subTitle} id={`timeline-day-${at}`}>
            {group.day}
          </h3>
          <ol className={styles.timeline} aria-labelledby={`timeline-day-${at}`}>
            {group.rows.map((row) => (
              <TimelineRow
                key={row.id}
                at={row.at}
                time={row.time}
                who={row.who}
                what={row.what}
                details={row.details}
                {...(row.note === undefined ? {} : { note: row.note })}
              />
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
