import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { type DayView, loadDay } from "@/schedule/day";
import { ScheduleError } from "@/schedule/errors";
import { DAY_BUTTONS } from "@/schedule/wording";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

import practice from "../practice.module.css";
import { SignedOut } from "../SignedOut";
import { dismissMoveAction, moveItAction, undoHoldAction } from "./actions";
import { DayActionButton } from "./DayActionButton";
import { DayBoard } from "./DayBoard";
import { DayLive } from "./DayLive";
import { DayCheck } from "./DayCheck";
import styles from "./day.module.css";
import { bookingSpans, LEAD_COLUMNS, openingLine } from "./opening";
import { PlainTimeline } from "./PlainTimeline";
import { dayBoardSetting } from "./setting";
import { dayStamp } from "./stamp";

export const metadata: Metadata = { title: "The day" };

export const dynamic = "force-dynamic";

/**
 * The practice's day (U8a, U8b): the day's bookings by room on a timeline,
 * each coloured by its case's money state, the schedule agent's holds and
 * proposed moves marked, with Undo on a held slot and Move it and Dismiss on
 * a proposed move (section 6's words; D9 (a)). The bookings are drawn on the
 * board, Bryntum's Scheduler, with the plain timeline under it as the floor
 * (`DayBoard`); the open day follows its cases' money without a reload
 * (`DayLive`).
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
  // Read before the day, so a change that lands between the two is asked after again, never missed.
  const stamp = await dayStamp(database().db, session.practiceId);
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
  const scrollTo = openingLine(firstLineInView(view), bookingSpans(view));

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
      <DayLive stamp={stamp} />

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
                    name={`${DAY_BUTTONS.undo} the hold on ${proposal.patientName}'s slot`}
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
                        name={`${DAY_BUTTONS.move}: ${proposal.move.patientName} to ${proposal.slot}`}
                        describedBy={`move-${proposal.id}`}
                      >
                        {DAY_BUTTONS.move}
                      </DayActionButton>
                      <DayActionButton
                        action={dismissMoveAction.bind(null, proposal.id)}
                        variant="quiet"
                        name={`${DAY_BUTTONS.dismiss} the move of ${proposal.move.patientName}`}
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
        <DayBoard view={view} openingLine={scrollTo} plain={dayBoardSetting() === "plain"}>
          <PlainTimeline view={view} openingLine={scrollTo} />
        </DayBoard>
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
