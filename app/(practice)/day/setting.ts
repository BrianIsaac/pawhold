/** How the day's bookings are to be drawn: on the board, or on the plain timeline alone. */
export type DayBoardSetting = "scheduler" | "plain";

/**
 * The deployment's setting for the day's board (U8b): `PAWHOLD_DAY_BOARD=plain`
 * keeps the day on the plain timeline and never loads the Scheduler, for
 * judge mode's fallback. Not set, or `scheduler`, the board is on. A value
 * it does not know is taken as `plain`: the setting exists to turn the board
 * off, so a mistyped one falls to the floor, never to the board.
 *
 * @param source - The environment; `process.env` by default.
 * @returns The setting.
 */
export function dayBoardSetting(
  source: Record<string, string | undefined> = process.env,
): DayBoardSetting {
  const value = source.PAWHOLD_DAY_BOARD?.trim().toLowerCase() ?? "";
  return value === "" || value === "scheduler" ? "scheduler" : "plain";
}
