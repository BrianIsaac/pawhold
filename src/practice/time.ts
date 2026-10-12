/**
 * The zone a practice reads its times in when it has set none: a UK
 * practice reads London's (D1). `practice.time_zone` (U8a) defaults to it.
 */
export const DEFAULT_TIME_ZONE = "Europe/London";

/** A practice's clock: an instant as the practice's screens show it, in its own zone. */
export interface PracticeClock {
  /** The zone, as the practice's settings name it ("Europe/London"). */
  readonly zone: string;
  /** A day as the practice reads it ("Tuesday 7 October"). */
  readonly day: (at: Date) => string;
  /** A time to the minute ("14:02"), as section 6's timeline shows it. */
  readonly minute: (at: Date) => string;
  /** A time to the second ("14:02:11"), as section 6's "confirmed" shows it. */
  readonly second: (at: Date) => string;
  /** The calendar day of an instant, as a key ("2026-10-07"). */
  readonly dayKey: (at: Date) => string;
}

const clocks = new Map<string, PracticeClock>();

/**
 * The practice's clock in a zone (U11: U5's screens read the practice's own
 * `time_zone`, U8a's finding 8). Its formatters are made once per zone.
 *
 * @param zone - The practice's zone (`practice.time_zone`).
 * @returns The clock.
 * @throws RangeError when the zone is not one the runtime knows.
 */
export function practiceClock(zone: string): PracticeClock {
  const known = clocks.get(zone);
  if (known) {
    return known;
  }
  const format = (locale: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone: zone, ...options });
  const day = format("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const minute = format("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const second = format("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const dayKey = format("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
  const clock: PracticeClock = {
    zone,
    day: (at) => day.format(at),
    minute: (at) => minute.format(at),
    second: (at) => second.format(at),
    dayKey: (at) => dayKey.format(at),
  };
  clocks.set(zone, clock);
  return clock;
}
