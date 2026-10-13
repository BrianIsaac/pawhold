import Link from "next/link";

import type { BookingFace } from "@/schedule/board";

import styles from "./day.module.css";

/**
 * One booking's block: a link to its case in its money's colours (U11's
 * tones), the agent's hold on it (the dashed frame and "Held by pawhold")
 * or the move it proposes (the dotted frame and "Move to {time} proposed").
 * The plain timeline and the board draw the same block. On the board a
 * block is not inside its room's list, so it names its room for a reader
 * who cannot see the row it sits in.
 *
 * @param props - The booking's face, and its room where the block must name it.
 * @param props.face - What the block shows.
 * @param props.room - The room's name, said but not shown.
 * @returns The block.
 */
export function BookingBlock({ face, room }: { face: BookingFace; room?: string }) {
  return (
    <Link
      href={`/cases/${face.caseId}`}
      className={styles.booking}
      data-tone={face.tone}
      data-held={face.held ? "" : undefined}
      data-move={face.moveTo ? "" : undefined}
      title={face.title}
    >
      <span className={styles.bookingBody}>
        <span className={styles.bookingStart} aria-hidden="true">
          {face.start}
        </span>
        <span className={styles.bookingTime}>{face.time}</span>
        <span className={styles.bookingPatient}>{face.patientName}</span>
        <span className={styles.bookingDetail}>{face.detail}</span>
        <span className={styles.bookingDetail}>{face.vetName}</span>
        <span className={styles.bookingMoney}>{face.money}</span>
        {face.held ? <span className={styles.mark}>Held by pawhold</span> : null}
        {face.moveTo ? <span className={styles.mark}>Move to {face.moveTo} proposed</span> : null}
        {room ? <span className="visually-hidden">{room}</span> : null}
      </span>
    </Link>
  );
}
