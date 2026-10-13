"use client";

import "@bryntum/scheduler/fontawesome/css/fontawesome.css";
import "@bryntum/scheduler/fontawesome/css/solid.css";
import "@bryntum/scheduler/scheduler.css";
import "@bryntum/scheduler/svalbard-light.css";

import {
  BryntumScheduler,
  type BryntumSchedulerProps,
} from "@bryntum/scheduler-react/lib/BryntumScheduler.js";
import { type CSSProperties, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { type BookingFace, boardOf, hourLabelAt } from "@/schedule/board";
import type { DayView } from "@/schedule/day";

import { NOW_CLASS } from "./board-marks";
import { BookingBlock } from "./BookingBlock";
import styles from "./day.module.css";

/** The plain timeline's measures, in rem, which the board keeps (U11): an hour, a room's row, the room names. */
const HOUR_REM = 18;
const ROW_REM = 8.25;
const LABEL_REM = { narrow: 6, wide: 8.5 } as const;

/** The viewport width from which the room names take their wide measure (the plain timeline's breakpoint). */
const WIDE_QUERY = "(min-width: 48rem)";

/** What of the Scheduler stays off: the board shows the day; the practice acts by the buttons above it. */
const OFF = {
  cellEditFeature: false,
  cellMenuFeature: false,
  columnPickerFeature: false,
  columnReorderFeature: false,
  columnResizeFeature: false,
  eventCopyPasteFeature: false,
  eventDragCreateFeature: false,
  eventDragFeature: false,
  eventEditFeature: false,
  eventMenuFeature: false,
  eventResizeFeature: false,
  eventTooltipFeature: false,
  groupFeature: false,
  headerMenuFeature: false,
  scheduleMenuFeature: false,
  scheduleTooltipFeature: false,
  sortFeature: false,
  stickyEventsFeature: false,
  timeAxisHeaderMenuFeature: false,
  enableDeleteKey: false,
  zoomOnMouseWheel: false,
  zoomOnTimeAxisDoubleClick: false,
} as const satisfies BryntumSchedulerProps;

/** The parts of an event that are its booking's face (`BoardEvent`), as the Scheduler's record keeps them. */
const FACE_FIELDS = [
  "caseId",
  "patientName",
  "detail",
  "vetName",
  "time",
  "start",
  "tone",
  "money",
  "held",
  "moveTo",
  "title",
] as const satisfies readonly (keyof BookingFace)[];

/**
 * A booking's face, read back from the Scheduler's record of its event.
 *
 * @param record - The event's record.
 * @param record.getData - Reads one of its fields.
 * @returns The face the board gave it.
 */
function faceOfRecord(record: { getData(field: string): unknown }): BookingFace {
  return Object.fromEntries(
    FACE_FIELDS.map((field) => [field, record.getData(field)]),
  ) as unknown as BookingFace;
}

/** What the Scheduler says of its parts to a reader: the roles of a grid whose events are buttons, and their states. */
const SCHEDULER_ROLES = ["region", "grid", "rowgroup", "row", "gridcell", "columnheader", "button"];
const SCHEDULER_STATES = [
  "aria-label",
  "aria-colcount",
  "aria-rowcount",
  "aria-colindex",
  "aria-rowindex",
  "aria-readonly",
  "aria-sort",
  "tabindex",
];
const SCHEDULER_MARKUP = [
  ...SCHEDULER_ROLES.map((role) => `[role='${role}']`),
  ...SCHEDULER_STATES.map((state) => `[role='presentation'][${state}]`),
].join(", ");

/**
 * Leaves the Scheduler's parts as plain layout for a reader and for the
 * keyboard. The board is read as the plain timeline is: a region holding the
 * rooms' names and the bookings' links, each link naming its room. The
 * Scheduler marks itself up as a grid whose events are buttons, to be walked
 * with its own arrow keys; here an event's block is the link, reached by Tab
 * like every other link of the page, so the Scheduler's roles, its labels
 * (which read the axis' stand-in dates) and its own stops for Tab are taken
 * off, each time it draws.
 *
 * @param root - The element the Scheduler is drawn in.
 */
function plainMarkup(root: HTMLElement): void {
  for (const part of root.querySelectorAll<HTMLElement>(SCHEDULER_MARKUP)) {
    part.setAttribute("role", "presentation");
    for (const state of SCHEDULER_STATES) {
      part.removeAttribute(state);
    }
  }
}

/**
 * Whether the viewport is at the width where the room names are wide.
 *
 * @returns Whether it is.
 */
function isWide(): boolean {
  return window.matchMedia(WIDE_QUERY).matches;
}

/**
 * Tells React when the viewport crosses that width.
 *
 * @param changed - Called on each crossing.
 * @returns Stops watching.
 */
function watchWidth(changed: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
}

/** The Scheduler's own notice that its trial has run out: its mask over the grid. */
const EXPIRY_MASK = "[id^='masktrial']";

/**
 * The board (U8b): the day on the Scheduler, rooms as its resources and
 * bookings as its events, each event the same block the plain timeline
 * draws. It is read only; the agent's proposals are answered by the buttons
 * above it. It reports when it has drawn, and when the Scheduler shows that
 * its trial has expired, so the day can fall back to the plain timeline.
 *
 * @param props - The day, where it opens, and what to tell the day.
 * @param props.view - The day.
 * @param props.openingLine - The grid line the board opens scrolled to.
 * @param props.onShown - Called once the Scheduler has drawn the day.
 * @param props.onExpired - Called when the Scheduler shows its trial has expired.
 * @returns The Scheduler.
 */
export default function SchedulerBoard({
  view,
  openingLine,
  onShown,
  onExpired,
}: {
  view: DayView;
  openingLine: number;
  onShown: () => void;
  onExpired: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const signature = JSON.stringify([view, openingLine]);
  // The day is read again each minute; the same day keeps the same arrays, so the Scheduler is left alone.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const board = useMemo(() => boardOf(view, openingLine), [signature]);
  const rem = useMemo(() => parseFloat(getComputedStyle(document.documentElement).fontSize), []);
  const wide = useSyncExternalStore(watchWidth, isWide);
  const labelPx = (wide ? LABEL_REM.wide : LABEL_REM.narrow) * rem;
  const hourPx = HOUR_REM * rem;

  useLayoutEffect(() => {
    const root = scroller.current!;
    const expired = () => root.querySelector(EXPIRY_MASK) != null;
    if (expired()) {
      onExpired();
      return;
    }
    plainMarkup(root);
    onShown();
    // The Scheduler draws again as the day changes: each time, its markup is made plain, and its expiry looked for.
    const watch = new MutationObserver(() => {
      if (expired()) {
        watch.disconnect();
        onExpired();
        return;
      }
      plainMarkup(root);
    });
    watch.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", ...SCHEDULER_STATES],
    });
    return () => watch.disconnect();
  }, [onShown, onExpired]);

  // Opens once for each day shown, as the plain timeline does: a practice that scrolled stays where it scrolled.
  const opened = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (opened.current === board.day || !scroller.current) {
      return;
    }
    scroller.current.scrollLeft = ((openingLine - 1) * hourPx) / 12;
    opened.current = board.day;
  }, [board.day, openingLine, hourPx]);

  return (
    <div
      ref={scroller}
      className={`${styles.scroller} ${styles.board}`}
      role="region"
      aria-label="The day's bookings, by room and time"
      tabIndex={0}
      style={{ "--label": `${labelPx}px` } as CSSProperties}
    >
      <div className={styles.boardSheet} style={{ width: labelPx + board.hours.length * hourPx }}>
        <BryntumScheduler
          key={`${board.day} ${board.hours.join(" ")} ${labelPx}`}
          {...OFF}
          readOnly
          autoHeight
          startDate={board.startDate}
          endDate={board.endDate}
          viewPreset={{
            base: "hourAndDay",
            tickWidth: hourPx,
            headers: [
              {
                unit: "hour",
                increment: 1,
                align: "start",
                renderer: (start: Date) => hourLabelAt(board, start),
              },
            ],
          }}
          rowHeight={ROW_REM * rem}
          barMargin={4}
          eventColor={null}
          eventStyle={null}
          columns={[
            {
              field: "name",
              text: "Room",
              width: labelPx,
              renderer: ({ value }: { value: unknown }) => (
                <span data-room="">{String(value)}</span>
              ),
            },
          ]}
          resources={board.resources as unknown as object[]}
          events={board.events as unknown as object[]}
          useInitialAnimation={false}
          keyMap={{ Tab: null, "Shift+Tab": null }}
          timeRangesFeature={{ showCurrentTimeLine: false, showHeaderElements: false }}
          timeRanges={
            board.now
              ? [{ id: "now", startDate: board.now, cls: `${styles.boardNow} ${NOW_CLASS}` }]
              : []
          }
          eventRenderer={({ eventRecord }) => (
            <BookingBlock
              face={faceOfRecord(eventRecord)}
              room={String(eventRecord.getData("room"))}
            />
          )}
        />
      </div>
    </div>
  );
}
