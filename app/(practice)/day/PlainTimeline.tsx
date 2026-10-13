import { type CSSProperties, Fragment } from "react";

import { faceOf } from "@/schedule/board";
import type { DayView } from "@/schedule/day";

import { NOW_CLASS } from "./board-marks";
import { BookingBlock } from "./BookingBlock";
import styles from "./day.module.css";
import { ScrollIntoDay } from "./ScrollIntoDay";

const SCROLLER_ID = "day-grid";

/**
 * The plain timeline (U8a's grid): a row per room, a column per five
 * minutes, each booking a block on it, the hours labelled and now a line
 * across the rooms. It is the floor under the board (the owner's rule of 13
 * October): drawn by the server, so it is on the page before the Scheduler
 * arrives and whenever the Scheduler does not.
 *
 * @param props - The day and where it opens.
 * @param props.view - The day.
 * @param props.openingLine - The grid line the view starts scrolled to.
 * @returns The grid in its scroller.
 */
export function PlainTimeline({ view, openingLine }: { view: DayView; openingLine: number }) {
  return (
    <>
      <div
        id={SCROLLER_ID}
        className={styles.scroller}
        role="region"
        aria-label="The day's bookings, by room and time"
        tabIndex={0}
      >
        <div
          className={styles.grid}
          style={{ "--slots": view.range.slots, "--rooms": view.rooms.length } as CSSProperties}
        >
          <div className={styles.corner} data-room-label="" aria-hidden="true" />
          <ol className={styles.hours} aria-hidden="true">
            {view.range.hours.slice(0, -1).map((hour) => (
              <li key={hour.line} style={{ gridColumn: `${hour.line} / span 12` }}>
                <span className={styles.hour}>{hour.label}</span>
              </li>
            ))}
          </ol>
          {view.rooms.map((lane, index) => (
            <Fragment key={lane.id}>
              <h3
                id={`room-${lane.id}`}
                className={styles.room}
                style={{ gridRow: index + 2 }}
                data-room=""
              >
                {lane.name}
              </h3>
              <ol
                className={styles.lane}
                style={{ gridRow: index + 2 }}
                aria-labelledby={`room-${lane.id}`}
              >
                {lane.bookings.map((one) => (
                  <li
                    key={one.id}
                    className={styles.slot}
                    style={{ gridColumn: `${one.column.start} / ${one.column.end}` }}
                  >
                    <BookingBlock face={faceOf(one)} />
                  </li>
                ))}
              </ol>
            </Fragment>
          ))}
          {view.now ? (
            <div
              className={`${styles.now} ${NOW_CLASS}`}
              style={{ gridColumn: `${view.now.line + 1} / span 1` }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </div>
      <ScrollIntoDay
        scrollerId={SCROLLER_ID}
        day={view.day}
        line={openingLine}
        slots={view.range.slots}
      />
    </>
  );
}
