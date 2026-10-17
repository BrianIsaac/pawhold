import type { Transaction } from "@/db/client";
import { currentPriceList } from "@/estimate/price-list";

import { seedPracticeDay } from "../practice/day";
import { SHOWCASE_CASE, seedShowcaseCase } from "../practice/showcase";
import { MONEY_STATE_CASES, OWNER_DOOR_CASE } from "./cases";
import { writeMoneyStateCase } from "./story";

/**
 * The showcase's money states: plan 3.2's, as section 6's chips name them,
 * with the per-hold flags (extended, honour period over) and the two ways a
 * hold is paid for. Each is shown by at least one seeded case.
 */
export const SHOWCASE_STATES = [
  "estimate_draft",
  "awaiting_owner",
  "held_paypal",
  "held_card",
  "update_awaiting_owner",
  "update_declined",
  "hold_extended",
  "honour_period_over",
  "captured",
  "released",
  "refunded",
  "withdrawn",
] as const;

export type ShowcaseState = (typeof SHOWCASE_STATES)[number];

/**
 * Which seeded case shows which money state, by patient: U5's Bramble and
 * U8a's day folded in with the showcase's own cases (U9), one practice, one
 * set of rooms and vets. The video unit and the testing instructions read
 * this to name a case for a state.
 */
export const SHOWCASE_CASES_BY_STATE: Readonly<Record<ShowcaseState, readonly string[]>> = {
  estimate_draft: ["Pip", "Moss"],
  awaiting_owner: [OWNER_DOOR_CASE.patientName, "Archie"],
  held_paypal: ["Hazel"],
  held_card: ["Willow", "Biscuit", "Clover"],
  update_awaiting_owner: ["Juno"],
  update_declined: [SHOWCASE_CASE.patientName],
  hold_extended: [SHOWCASE_CASE.patientName, "Rufus"],
  honour_period_over: ["Rufus"],
  captured: ["Poppy"],
  released: ["Teddy"],
  refunded: ["Luna"],
  withdrawn: ["Milo"],
};

/** What the showcase seeded into a practice. */
export interface SeededShowcase {
  /** U5's Bramble: the timeline with every kind of row. */
  readonly showcaseCaseId: string;
  /** U8a's Juno: the update the schedule agent waits on. */
  readonly dayCaseId: string;
  /** The case the owner's door opens: an estimate waiting for its owner. */
  readonly ownerDoorCaseId: string;
  readonly bookings: number;
  /** Bramble's id and the showcase's own cases' ids, by patient. */
  readonly caseIds: Readonly<Record<string, string>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * When the showcase's own stories start, UTC: early enough that the latest
 * of them ends before Bramble's last event (the day before, 08:45), so U5's
 * showcase case stays first on today's list, as U8a's day keeps it.
 */
const STORY_HOUR_UTC = 7;
const MINUTE_MS = 60 * 1000;

/**
 * Seeds the showcase into a new judge practice, inside the transaction that
 * makes it, after its price list is imported: U5's Bramble, U8a's day (its
 * rooms, vets, cases and bookings around the session's start), then the
 * showcase's own cases, so that between them every money state of plan 3.2
 * is on today's list the first time a judge looks. Each case's story is
 * back-dated from `now`, ends in the past and says it is seeded (D16).
 *
 * @param tx - The transaction making the practice.
 * @param practiceId - The practice.
 * @param now - The session's start.
 * @returns What was seeded.
 * @throws Error when the practice has no price list or a line's item is not on it.
 */
export async function seedShowcase(
  tx: Transaction,
  practiceId: string,
  now: Date = new Date(),
): Promise<SeededShowcase> {
  const list = await currentPriceList(tx, practiceId);
  if (!list) {
    throw new Error("the showcase is priced from the practice's list: import it first");
  }
  const showcaseCaseId = await seedShowcaseCase(tx, practiceId, now);
  const day = await seedPracticeDay(tx, practiceId, { showcaseCaseId, now });

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const caseIds: Record<string, string> = { [SHOWCASE_CASE.patientName]: showcaseCaseId };
  for (const [index, kase] of MONEY_STATE_CASES.entries()) {
    const written = await writeMoneyStateCase(tx, {
      practiceId,
      list,
      kase,
      startsAt: new Date(
        today - kase.daysAgo * DAY_MS + STORY_HOUR_UTC * 60 * MINUTE_MS + index * 7 * MINUTE_MS,
      ),
    });
    caseIds[kase.patientName] = written.caseId;
  }
  return {
    showcaseCaseId,
    dayCaseId: day.dayCaseId,
    ownerDoorCaseId: caseIds[OWNER_DOOR_CASE.patientName]!,
    bookings: day.bookings,
    caseIds,
  };
}
