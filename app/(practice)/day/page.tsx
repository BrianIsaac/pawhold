import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { type CSSProperties, Fragment } from "react";

import { type DayView, loadDay } from "@/schedule/day";
import { ScheduleError } from "@/schedule/errors";
import { DAY_BUTTONS } from "@/schedule/wording";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

import practice from "../practice.module.css";
import { SignedOut } from "../SignedOut";
import { dismissMoveAction, moveItAction, undoHoldAction } from "./actions";
import { DayActionButton } from "./DayActionButton";
import { DayCheck } from "./DayCheck";
import styles from "./day.module.css";
import { LEAD_COLUMNS, ScrollIntoDay } from "./ScrollIntoDay";

export const metadata: Metadata = { title: "The day" };

export const dynamic = "force-dynamic";

const SCROLLER_ID = "day-grid";

/**
 * The practice's day (U8a, the plain view; U8b's Bryntum board replaces the
 * grid and keeps this data and these actions): the day's bookings by room on
 * a timeline, each coloured by its case's money state, the schedule agent's
 * holds and proposed moves marked, with Undo on a held slot and Move it and
 * Dismiss on a proposed move (section 6's words; D9 (a)).
 *
 * @param props - The route's search parameters.
 * @param props.searchParams - `day`, a calendar day ("2026-10-12"); today when absent.
 * @returns The page.
 */
export default async function DayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentPracticeSession();
  if (!session) {
    return <SignedOut />;
  }
  const { day } = await searchParams;
  let view: DayView;
  try {
    view = await loadDay(database().db, session.practiceId, {
      day: typeof day === "string" ? day : undefined,
    });
  } catch (error) {
    if (error instanceof ScheduleError && error.reason === "request_invalid") {
      notFound();
    }
    throw error;
  }
  const scrollTo = firstLineInView(view);

  return (
    <>
      <div className={practice.pageHead}>
        <div className={styles.heading}>
          <h1 className={practice.title}>The day</h1>
          <p className={styles.date}>
            {view.label}
            {view.isToday ? ", today" : ""}
          </p>
        </div>
        <nav aria-label="Days" className={styles.days}>
          <Link href={`/day?day=${view.previousDay}` as Route} className={styles.dayLink}>
            Previous day
          </Link>
          {view.isToday ? null : (
            <Link href="/day" className={styles.dayLink}>
              Today
            </Link>
          )}
          <Link href={`/day?day=${view.nextDay}` as Route} className={styles.dayLink}>
            Next day
          </Link>
        </nav>
      </div>
      <DayCheck timeZone={view.timeZone} />

      {view.proposals.length > 0 ? (
        <section aria-labelledby="held-heading" className={styles.held}>
          <h2 id="held-heading" className={styles.sectionTitle}>
            Held by pawhold
          </h2>
          <ul className={styles.proposals}>
            {view.proposals.map((proposal) => (
              <li key={proposal.id} className={styles.proposal}>
                <h3 className={styles.proposalTitle}>
                  {proposal.roomName}, {proposal.slot}: {proposal.patientName}
                </h3>
                <div className={styles.proposalPart}>
                  <p id={`held-${proposal.id}`} className={styles.proposalWords}>
                    <span className={styles.heldNote}>{proposal.heldNote}</span> {proposal.reason}
                  </p>
                  <DayActionButton
                    action={undoHoldAction.bind(null, proposal.id)}
                    variant="secondary"
                    describedBy={`held-${proposal.id}`}
                  >
                    {DAY_BUTTONS.undo}
                  </DayActionButton>
                </div>
                {proposal.move ? (
                  <div className={styles.proposalPart}>
                    <p id={`move-${proposal.id}`} className={styles.proposalWords}>
                      {proposal.move.question}
                    </p>
                    <div className={styles.buttons}>
                      <DayActionButton
                        action={moveItAction.bind(null, proposal.id)}
                        describedBy={`move-${proposal.id}`}
                      >
                        {DAY_BUTTONS.move}
                      </DayActionButton>
                      <DayActionButton
                        action={dismissMoveAction.bind(null, proposal.id)}
                        variant="quiet"
                        describedBy={`move-${proposal.id}`}
                      >
                        {DAY_BUTTONS.dismiss}
                      </DayActionButton>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="bookings-heading" className={styles.bookings}>
        <h2 id="bookings-heading" className={styles.sectionTitle}>
          Bookings by room
        </h2>
        {view.bookingCount === 0 ? (
          <p className={styles.empty}>Nothing is booked on {view.label}.</p>
        ) : null}
        <div
          id={SCROLLER_ID}
          className={styles.scroller}
          role="region"
          aria-labelledby="bookings-heading"
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
                  {hour.label}
                </li>
              ))}
            </ol>
            {view.rooms.map((lane, index) => (
              <Fragment key={lane.id}>
                <h3 id={`room-${lane.id}`} className={styles.room} style={{ gridRow: index + 2 }}>
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
                      <Link
                        href={`/cases/${one.caseId}`}
                        className={styles.booking}
                        data-tone={one.chip.tone}
                        data-held={one.held ? "" : undefined}
                        data-move={one.moveProposed ? "" : undefined}
                        title={`${one.time}: ${one.patientName}, ${one.kind === "consult" ? "consult" : one.procedure}, ${one.vetName}. ${one.chip.label}.`}
                      >
                        <span className={styles.bookingBody}>
                          <span className={styles.bookingStart} aria-hidden="true">
                            {one.start}
                          </span>
                          <span className={styles.bookingTime}>{one.time}</span>
                          <span className={styles.bookingPatient}>{one.patientName}</span>
                          <span className={styles.bookingDetail}>
                            {one.kind === "consult" ? "Consult" : one.procedure}
                          </span>
                          <span className={styles.bookingDetail}>{one.vetName}</span>
                          <span className={styles.bookingMoney}>{one.chip.label}</span>
                          {one.held ? <span className={styles.mark}>Held by pawhold</span> : null}
                          {one.moveProposed ? (
                            <span className={styles.mark}>
                              Move to {one.moveProposed.to} proposed
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </Fragment>
            ))}
            {view.now ? (
              <div
                className={styles.now}
                style={{ gridColumn: `${view.now.line + 1} / span 1` }}
                aria-hidden="true"
              />
            ) : null}
          </div>
        </div>
        <ScrollIntoDay scrollerId={SCROLLER_ID} line={scrollTo} slots={view.range.slots} />
      </section>
    </>
  );
}

/**
 * The grid line the day opens scrolled to: today, the first booking not yet
 * over (or now, when every booking is over); another day, its first booking.
 *
 * @param view - The day.
 * @returns The grid line (the first is 1).
 */
function firstLineInView(view: DayView): number {
  const bookings = view.rooms.flatMap((lane) => lane.bookings);
  const now = view.now?.line;
  const open = bookings.filter((one) => now === undefined || one.column.end > now);
  const first = Math.min(...open.map((one) => one.column.start));
  if (Number.isFinite(first)) {
    return first;
  }
  return now ?? 1 + LEAD_COLUMNS;
}
