"use client";

import dynamic from "next/dynamic";
import { Component, type ReactNode, useCallback, useEffect, useState } from "react";

import type { DayView } from "@/schedule/day";

import styles from "./day.module.css";

/** The Scheduler, client only (Bryntum's Next.js guide): never drawn by the server. */
const SchedulerBoard = dynamic(() => import("./SchedulerBoard"), { ssr: false });

/** How long the Scheduler is given to draw before the day stays on the plain timeline. */
export const BOARD_TIMEOUT_MS = 10_000;

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
 * breaks on the Scheduler.
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
  const [shown, setShown] = useState(false);
  const [fallback, setFallback] = useState<Fallback | null>(plain ? "forced" : null);
  const onShown = useCallback(() => setShown(true), []);
  const onFailed = useCallback(() => setFallback("failed"), []);
  const onExpired = useCallback(() => setFallback("expired"), []);

  useEffect(() => {
    if (shown || fallback) {
      return;
    }
    const timer = window.setTimeout(() => setFallback("timeout"), BOARD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [shown, fallback]);

  const onBoard = shown && !fallback;
  return (
    <div
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
