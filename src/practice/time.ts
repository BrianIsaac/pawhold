/** The practice's clock: a UK practice reads its times in London's (D1). */
export const PRACTICE_TIME_ZONE = "Europe/London";

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: PRACTICE_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

const minuteFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: PRACTICE_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const secondFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: PRACTICE_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: PRACTICE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * A day as the practice reads it ("Tuesday 7 October").
 *
 * @param at - The instant.
 * @returns The day.
 */
export function practiceDay(at: Date): string {
  return dayFormat.format(at);
}

/**
 * A time to the minute ("14:02"), as section 6's timeline shows it.
 *
 * @param at - The instant.
 * @returns The time.
 */
export function practiceMinute(at: Date): string {
  return minuteFormat.format(at);
}

/**
 * A time to the second ("14:02:11"), as section 6's "confirmed" shows it.
 *
 * @param at - The instant.
 * @returns The time.
 */
export function practiceSecond(at: Date): string {
  return secondFormat.format(at);
}

/**
 * The practice's calendar day of an instant, as a key ("2026-10-07").
 *
 * @param at - The instant.
 * @returns The key.
 */
export function practiceDayKey(at: Date): string {
  return dayKeyFormat.format(at);
}
