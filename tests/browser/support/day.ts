import { expect, type Locator, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { booking, patientCase } from "@/db/schema";

import { signInAsPractice } from "../fixtures";
import { openBrowserDatabase } from "../owner/support/cases";

/*
 * The practice's day in its two states (U8b): on the board, Bryntum's
 * Scheduler, and on the plain timeline, the floor under it, which the day
 * stays on whenever the Scheduler does not draw. The walks of the day run in
 * both; a walk of the plain timeline has the Scheduler's module fail to load.
 */

/** How the day's bookings are drawn. */
export type DayState = "board" | "plain";

export const DAY_STATES: readonly DayState[] = ["board", "plain"];

/** A state as a walk's title names it. */
export const STATE_WORDS: Record<DayState, string> = {
  board: "on the board",
  plain: "on the plain timeline",
};

/** The address the browser asks for the Scheduler's module (`app/(practice)/day/scheduler/route.ts`). */
export const SCHEDULER_MODULE = "**/day/scheduler";

/** The day's grid, either way: the region the keyboard scrolls. */
export const GRID_NAME = "The day's bookings, by room and time";

/**
 * Makes the Scheduler's module fail to load for a page, as a network that
 * drops it would, so the day stays on the plain timeline.
 *
 * @param page - The page, before it opens the day.
 */
export async function failTheScheduler(page: Page): Promise<void> {
  await page.route(SCHEDULER_MODULE, (route) => route.abort("failed"));
}

/**
 * Prepares a page for a walk of the day in one state.
 *
 * @param page - The page, before it opens the day.
 * @param state - The state the walk is of.
 */
export async function prepareDay(page: Page, state: DayState): Promise<void> {
  if (state === "plain") {
    await failTheScheduler(page);
  }
}

/**
 * Waits until the day is drawn in a state: the board once the Scheduler has
 * drawn it, the plain timeline once the day has settled on it.
 *
 * @param page - The page, on the day.
 * @param state - The state.
 */
export async function shownAs(page: Page, state: DayState): Promise<void> {
  await expect(
    page.locator(
      state === "board"
        ? "[data-day-board='scheduler']"
        : "[data-day-board='plain'][data-fallback]",
    ),
  ).toBeVisible();
}

/**
 * The calendar day in London of an instant.
 *
 * @param at - The instant.
 * @returns "2026-10-12".
 */
export function londonDayOf(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * The calendar day in London of an instant some minutes from now.
 *
 * @param minutes - Minutes from now.
 * @returns "2026-10-12".
 */
export function londonDay(minutes: number): string {
  return londonDayOf(new Date(Date.now() + minutes * 60 * 1000));
}

/**
 * When each of a practice's seeded procedures starts, by patient.
 *
 * @param practiceId - The practice.
 * @returns The starts.
 */
export async function procedureStarts(practiceId: string): Promise<Map<string, Date>> {
  const database = openBrowserDatabase();
  try {
    const rows = await database.db
      .select({ patient: patientCase.patientName, startsAt: booking.startsAt })
      .from(booking)
      .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
      .where(and(eq(booking.practiceId, practiceId), eq(booking.kind, "procedure")));
    return new Map(rows.map((one) => [one.patient, one.startsAt]));
  } finally {
    await database.close();
  }
}

/** The held day as a walk finds it. */
export interface HeldDay {
  readonly practiceId: string;
  /** The held slot's start, as the proposal names it ("16:30"). */
  readonly slot: string;
  /**
   * Whether the agent can offer to move Biscuit into the slot: the seed books
   * Biscuit's procedure after Juno's, which falls on the next day in London
   * when the session starts late in the evening, and the agent never moves a
   * procedure across days (U8a's rule; U11's finding).
   */
  readonly moveOffered: boolean;
}

/**
 * Signs in as a new seeded practice and opens the day its case due inside the
 * lead time falls on, once the agent's first check has held its slot and the
 * day is drawn in the walk's state.
 *
 * @param page - The page, prepared for the state.
 * @param state - The state.
 * @returns The practice, the held slot's start and whether a move is offered.
 */
export async function openHeldDay(page: Page, state: DayState): Promise<HeldDay> {
  const practiceId = await signInAsPractice(page);
  await page.goto(`/day?day=${londonDay(30)}`);
  const held = page.getByRole("region", { name: "Held by pawhold" });
  await expect(held).toBeVisible();
  await shownAs(page, state);
  const title = await held.getByRole("heading", { level: 3 }).first().textContent();
  const slot = /^Theatre 1, (\d\d:\d\d): Juno$/.exec(title ?? "")?.[1];
  expect(slot, title ?? "").toBeDefined();
  const starts = await procedureStarts(practiceId);
  return {
    practiceId,
    slot: slot!,
    moveOffered: londonDayOf(starts.get("Juno")!) === londonDayOf(starts.get("Biscuit")!),
  };
}

/**
 * A booking's link on the grid, by its patient.
 *
 * @param page - The page.
 * @param patient - The patient.
 * @returns The link.
 */
export function bookingOf(page: Page, patient: string): Locator {
  return page
    .getByRole("region", { name: "Bookings by room" })
    .getByRole("link", { name: new RegExp(`\\b${patient}\\b`) });
}

/**
 * The right edge of the room names, which stay in view at the grid's left.
 *
 * @param page - The page, on the day.
 * @param state - The state the day is drawn in.
 * @returns The edge's x, in the page's pixels.
 */
export async function roomNamesEdge(page: Page, state: DayState): Promise<number> {
  const grid = page.getByRole("region", { name: GRID_NAME });
  const corner = await grid
    .locator(state === "board" ? ".b-grid-header-scroller-locked" : "[data-room-label]")
    .boundingBox();
  return corner!.x + corner!.width;
}

/**
 * The hour cells along the top of the grid.
 *
 * @param page - The page, on the day.
 * @param state - The state the day is drawn in.
 * @returns The cells.
 */
export function hourCells(page: Page, state: DayState): Locator {
  return page
    .getByRole("region", { name: GRID_NAME })
    .locator(state === "board" ? ".b-sch-header-time-axis-cell" : "ol[aria-hidden='true'] > li");
}
