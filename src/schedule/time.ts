/**
 * The practice's clock (U8a): times are kept in UTC and read in the
 * practice's zone, a setting (Europe/London unless the practice sets
 * another). Formatters are made once per zone.
 */

const formatters = new Map<
  string,
  Readonly<Record<"minute" | "day" | "key", Intl.DateTimeFormat>>
>();

/**
 * The formatters of one zone.
 *
 * @param zone - An IANA zone name.
 * @returns The minute, day and day-key formatters.
 */
function clockIn(zone: string): Readonly<Record<"minute" | "day" | "key", Intl.DateTimeFormat>> {
  let clock = formatters.get(zone);
  if (!clock) {
    clock = {
      minute: new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
      day: new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        weekday: "long",
        day: "numeric",
        month: "long",
      }),
      key: new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    };
    formatters.set(zone, clock);
  }
  return clock;
}

/**
 * A time to the minute in the practice's zone ("14:05").
 *
 * @param zone - The practice's zone.
 * @param at - The instant.
 * @returns The time.
 */
export function minuteIn(zone: string, at: Date): string {
  return clockIn(zone).minute.format(at);
}

/**
 * A day as the practice reads it ("Monday 12 October").
 *
 * @param zone - The practice's zone.
 * @param at - The instant.
 * @returns The day.
 */
export function dayIn(zone: string, at: Date): string {
  return clockIn(zone).day.format(at);
}

/**
 * The practice's calendar day of an instant, as a key ("2026-10-12").
 *
 * @param zone - The practice's zone.
 * @param at - The instant.
 * @returns The key.
 */
export function dayKeyIn(zone: string, at: Date): string {
  return clockIn(zone).key.format(at);
}

/**
 * How far a zone is ahead of UTC at an instant, in minutes.
 *
 * @param zone - The zone.
 * @param at - The instant.
 * @returns The offset (60 for British Summer Time).
 */
function offsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((one) => one.type === type)?.value);
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant a wall-clock time on a calendar day happens in a zone. A time
 * a clock change skips is read with the offset before the change.
 *
 * @param zone - The zone.
 * @param dayKey - The day ("2026-10-12").
 * @param minutes - Minutes after midnight on that day's wall clock (1440 is the next midnight).
 * @returns The instant.
 */
export function wallClockIn(zone: string, dayKey: string, minutes: number): Date {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(year, month - 1, day) + minutes * 60_000;
  const first = naive - offsetMinutes(zone, new Date(naive)) * 60_000;
  return new Date(naive - offsetMinutes(zone, new Date(first)) * 60_000);
}
