"use client";

import dynamic from "next/dynamic";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { DayView } from "@/schedule/day";

import styles from "./day.module.css";

/** The Scheduler, client only (Bryntum's Next.js guide): never drawn by the server. */
const SchedulerBoard = dynamic(() => import("./SchedulerBoard"), { ssr: false });

/** How long the Scheduler is given to draw before the day stays on the plain timeline. */
export const BOARD_TIMEOUT_MS = 10_000;

/** The grid itself, as the place the keyboard stood (it is focusable, to be scrolled by the arrow keys). */
const GRID = "";

/** Why the day is on the plain timeline rather than the board. */
export type Fallback = "forced" | "failed" | "expired" | "timeout";

/** Catches whatever the Scheduler throws while it loads or draws. */
class BoardBoundary extends Component<{ onFail: () => void; children: ReactNode }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onFail();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The day's bookings, on the board when the Scheduler can draw them and on
 * the plain timeline whenever it cannot (the owner's rule of 13 October):
 * the plain timeline, drawn by the server, stands until the Scheduler has
 * drawn the day, and comes back if the Scheduler fails to load, throws,
 * takes too long, or shows that its trial has expired. The page never
 * breaks on the Scheduler. When the board takes over, the keyboard stays on
 * the booking it stood on and the grid where it was scrolled.
 *
 * @param props - The day, where it opens, the setting and the plain timeline.
 * @param props.view - The day.
 * @param props.openingLine - The grid line the day opens scrolled to.
 * @param props.plain - Whether the plain timeline is forced (`PAWHOLD_DAY_BOARD=plain`).
 * @param props.children - The plain timeline.
 * @returns The board, or the plain timeline.
 */
export function DayBoard({
  view,
  openingLine,
  plain,
  children,
}: {
  view: DayView;
  openingLine: number;
  plain: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [fallback, setFallback] = useState<Fallback | null>(plain ? "forced" : null);
  /** Where the keyboard stood on the plain timeline when the board took over: a booking's address, or the grid. */
  const stoodOn = useRef<string | null>(null);
  const onShown = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.current?.contains(active)) {
      stoodOn.current = active.getAttribute("href") ?? GRID;
    }
    setShown(true);
  }, []);
  const onFailed = useCallback(() => setFallback("failed"), []);
  const onExpired = useCallback(() => setFallback("expired"), []);

  useEffect(() => {
    if (shown || fallback) {
      return;
    }
    const timer = window.setTimeout(() => setFallback("timeout"), BOARD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [shown, fallback]);

  // The plain timeline's elements go as the board takes over; the keyboard is put back where it stood.
  useLayoutEffect(() => {
    const stood = stoodOn.current;
    if (!shown || stood === null) {
      return;
    }
    stoodOn.current = null;
    const grid = root.current?.querySelector<HTMLElement>("[role='region']");
    const place =
      stood === GRID
        ? grid
        : [...(grid?.querySelectorAll<HTMLElement>("a[href]") ?? [])].find(
            (link) => link.getAttribute("href") === stood,
          );
    place?.focus({ preventScroll: true });
  }, [shown]);

  const onBoard = shown && !fallback;
  return (
    <div
      ref={root}
      className={styles.dayBoard}
      data-day-board={onBoard ? "scheduler" : "plain"}
      data-fallback={fallback ?? undefined}
    >
      {fallback ? null : (
        <BoardBoundary onFail={onFailed}>
          <div className={styles.boardStage} data-shown={shown ? "" : undefined}>
            <SchedulerBoard
              view={view}
              openingLine={openingLine}
              onShown={onShown}
              onExpired={onExpired}
            />
          </div>
        </BoardBoundary>
      )}
      {onBoard ? null : children}
    </div>
  );
}
