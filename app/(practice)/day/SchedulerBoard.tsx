"use client";

import "@bryntum/scheduler/fontawesome/css/fontawesome.css";
import "@bryntum/scheduler/fontawesome/css/solid.css";
import "@bryntum/scheduler/scheduler.css";
import "@bryntum/scheduler/svalbard-light.css";

import {
  BryntumScheduler,
  type BryntumSchedulerProps,
} from "@bryntum/scheduler-react/lib/BryntumScheduler.js";
import {
  type CSSProperties,
  type JSX,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { type BookingFace, boardOf, hourLabelAt } from "@/schedule/board";
import type { DayView } from "@/schedule/day";

import { NOW_CLASS, PLAIN_SCROLLER_ID } from "./board-marks";
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

/** The Scheduler's own Tab handling stays off: the page's Tab order reaches each booking's link. */
const KEY_MAP = { Tab: null, "Shift+Tab": null } as const;

/** Now is the day's own line (the practice's clock), never the Scheduler's reading of the browser's clock. */
const TIME_RANGES = { showCurrentTimeLine: false, showHeaderElements: false } as const;

/**
 * An event's content: its booking's block, naming its room.
 *
 * @param context - The Scheduler's rendering of one event.
 * @param context.eventRecord - The event's record.
 * @returns The block.
 */
function renderEvent({
  eventRecord,
}: {
  eventRecord: { getData(field: string): unknown };
}): JSX.Element {
  return (
    <BookingBlock face={faceOfRecord(eventRecord)} room={String(eventRecord.getData("room"))} />
  );
}

/**
 * A room's name in its row, marked so a walk can find the rooms in order.
 *
 * @param context - The Scheduler's rendering of one cell.
 * @param context.value - The room's name.
 * @returns The name.
 */
function renderRoom({ value }: { value: unknown }): JSX.Element {
  return <span data-room="">{String(value)}</span>;
}

/**
 * The board (U8b): the day on the Scheduler, rooms as its resources and
 * bookings as its events, each event the same block the plain timeline
 * draws. It is read only; the agent's proposals are answered by the buttons
 * above it. It reports once the Scheduler has drawn every room and booking
 * of the day, and when the Scheduler shows that its trial has expired, so
 * the day can stay on, or go back to, the plain timeline.
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
  const rem = useMemo(() => parseFloat(getComputedStyle(document.documentElement).fontSize), []);
  const wide = useSyncExternalStore(watchWidth, isWide);
  const labelPx = (wide ? LABEL_REM.wide : LABEL_REM.narrow) * rem;
  const hourPx = HOUR_REM * rem;

  /*
   * The day is read again each minute and on every change. Each part the
   * Scheduler is given keeps its identity until what it says changes, so the
   * Scheduler is handed only what is new (its wrapper applies again every
   * property that is not the very object it had).
   */
  const signature = JSON.stringify([view, openingLine]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const board = useMemo(() => boardOf(view, openingLine), [signature]);
  const hours = board.hours.join(" ");
  const rooms = JSON.stringify(board.resources);
  const now = board.now?.getTime() ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const axis = useMemo(() => ({ startDate: board.startDate, endDate: board.endDate }), [hours]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resources = useMemo(() => board.resources as unknown as object[], [rooms]);
  const events = board.events as unknown as object[];
  const viewPreset = useMemo(
    (): NonNullable<BryntumSchedulerProps["viewPreset"]> => ({
      base: "hourAndDay",
      tickWidth: hourPx,
      headers: [
        {
          unit: "hour",
          increment: 1,
          align: "start",
          renderer: (start: Date) =>
            hourLabelAt({ startDate: axis.startDate, hours: hours.split(" ") }, start),
        },
      ],
    }),
    [axis, hours, hourPx],
  );
  const columns = useMemo(
    () => [{ field: "name", text: "Room", width: labelPx, renderer: renderRoom }],
    [labelPx],
  );
  const timeRanges = useMemo(
    () =>
      now === null
        ? []
        : [{ id: "now", startDate: new Date(now), cls: `${styles.boardNow} ${NOW_CLASS}` }],
    [now],
  );

  // What "drawn" means for this day, for the watcher below: every room's name and every booking's block.
  const expected = useRef({ rooms: 0, bookings: 0 });
  useLayoutEffect(() => {
    expected.current = { rooms: board.resources.length, bookings: board.events.length };
  }, [board]);

  useLayoutEffect(() => {
    const root = scroller.current!;
    let shown = false;
    const look = (): boolean => {
      if (root.querySelector(EXPIRY_MASK) != null) {
        onExpired();
        return true;
      }
      plainMarkup(root);
      if (
        !shown &&
        root.querySelector(".b-scheduler") != null &&
        root.querySelectorAll("[data-room]").length === expected.current.rooms &&
        root.querySelectorAll("a[data-tone]").length === expected.current.bookings
      ) {
        shown = true;
        // The board takes over where the plain timeline stood, if the practice has scrolled it.
        const plain = document.getElementById(PLAIN_SCROLLER_ID);
        if (plain) {
          root.scrollLeft = plain.scrollLeft;
        }
        onShown();
      }
      return false;
    };
    if (look()) {
      return;
    }
    // The Scheduler draws again as the day changes: each time, its markup is made plain, and its expiry looked for.
    const watch = new MutationObserver(() => {
      if (look()) {
        watch.disconnect();
      }
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
          key={`${board.day} ${hours} ${labelPx}`}
          {...OFF}
          readOnly
          autoHeight
          useInitialAnimation={false}
          startDate={axis.startDate}
          endDate={axis.endDate}
          viewPreset={viewPreset}
          rowHeight={ROW_REM * rem}
          barMargin={4}
          eventColor={null}
          eventStyle={null}
          columns={columns}
          resources={resources}
          events={events}
          keyMap={KEY_MAP}
          timeRangesFeature={TIME_RANGES}
          timeRanges={timeRanges}
          eventRenderer={renderEvent}
        />
      </div>
    </div>
  );
}
