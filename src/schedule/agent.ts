import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Database, Transaction } from "@/db/client";
import {
  booking,
  estimateVersion,
  patientCase,
  practice,
  room,
  scheduleProposal,
  vet,
} from "@/db/schema";
import type { MoneyState } from "@/money/state";
import { firstName } from "@/practice/chips";

import { brokenScheduleConstraint, ScheduleError } from "./errors";
import { dayKeyIn, minuteIn } from "./time";
import { holdReason, moveQuestion } from "./wording";

const MINUTE_MS = 60 * 1000;

/** What one sweep of the practice's day did, by proposal id. */
export interface SweepReport {
  /** Slots held at once (D9 (a)): `schedule.slot_held`. */
  readonly held: string[];
  /** Of those, the ones with a move proposed beside the hold: `schedule.move_proposed`. */
  readonly moveProposed: string[];
  /** Holds released because their update was answered: `schedule.slot_released`. */
  readonly released: string[];
  /** Moves withdrawn: the update answered, or the held slot started (`schedule.proposal_withdrawn`). */
  readonly withdrawn: string[];
}

/** What the sweep needs: the clock, and a practice when it sweeps only one. */
export interface SweepOptions {
  readonly now?: Date;
  /** One practice only (the day view's check; the tests on a shared database). */
  readonly practiceId?: string;
}

/**
 * The schedule agent's rule (plan 3.4's third job; D9 (a)): a rule, not a
 * model call (U4's decision 1). For each procedure whose case's update waits
 * on the owner and whose start is inside the practice's lead time, with no
 * hold yet for that update, it holds the slot at once and proposes moving the
 * room's next procedure into it, which only the practice's click applies. A
 * hold whose update was answered is released and its move withdrawn; a move
 * whose slot has started is withdrawn. Every transition is one audit event,
 * written in the transaction that makes it. Idempotent: a second sweep at the
 * same clock changes nothing, and two at once hold once.
 *
 * @param db - The database.
 * @param options - The clock and an optional practice.
 * @returns What the sweep did.
 */
export async function sweepSchedule(
  db: Database["db"],
  options: SweepOptions = {},
): Promise<SweepReport> {
  const now = options.now ?? new Date();
  const scope = options.practiceId;
  const report: SweepReport = { held: [], moveProposed: [], released: [], withdrawn: [] };

  const latestSent = sql<string | null>`(
    select ${estimateVersion.id} from ${estimateVersion}
    where ${estimateVersion.caseId} = ${scheduleProposal.caseId}
      and ${estimateVersion.sentAt} is not null
    order by ${estimateVersion.number} desc limit 1)`;
  const answered = await db
    .select({ id: scheduleProposal.id })
    .from(scheduleProposal)
    .innerJoin(patientCase, eq(patientCase.id, scheduleProposal.caseId))
    .where(
      and(
        isNull(scheduleProposal.releasedAt),
        scope ? eq(scheduleProposal.practiceId, scope) : undefined,
        sql`(${patientCase.moneyState} <> 'update_awaiting_owner'
          or ${latestSent} is distinct from ${scheduleProposal.versionId})`,
      ),
    )
    .orderBy(asc(scheduleProposal.heldAt));
  for (const { id } of answered) {
    const done = await db.transaction((tx) => releaseAnswered(tx, id, now));
    if (done.released) {
      report.released.push(id);
    }
    if (done.withdrawn) {
      report.withdrawn.push(id);
    }
  }

  const started = await db
    .select({ id: scheduleProposal.id })
    .from(scheduleProposal)
    .where(
      and(
        isNull(scheduleProposal.releasedAt),
        eq(scheduleProposal.moveStatus, "proposed"),
        lte(scheduleProposal.moveTo, now),
        scope ? eq(scheduleProposal.practiceId, scope) : undefined,
      ),
    );
  for (const { id } of started) {
    if (await db.transaction((tx) => withdrawStarted(tx, id, now))) {
      report.withdrawn.push(id);
    }
  }

  const due = await db
    .select({ id: booking.id })
    .from(booking)
    .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
    .innerJoin(practice, eq(practice.id, booking.practiceId))
    .where(
      and(
        eq(booking.kind, "procedure"),
        eq(patientCase.moneyState, "update_awaiting_owner"),
        gt(booking.startsAt, now),
        sql`${booking.startsAt} <= ${now.toISOString()}::timestamptz + make_interval(mins => ${practice.scheduleLeadMinutes})`,
        sql`not exists (select 1 from ${scheduleProposal}
          where ${scheduleProposal.bookingId} = ${booking.id} and ${scheduleProposal.releasedAt} is null)`,
        scope ? eq(booking.practiceId, scope) : undefined,
      ),
    )
    .orderBy(asc(booking.startsAt));
  for (const { id } of due) {
    const held = await db.transaction((tx) => holdSlot(tx, id, now));
    if (held) {
      report.held.push(held.proposalId);
      if (held.moveProposed) {
        report.moveProposed.push(held.proposalId);
      }
    }
  }
  return report;
}

/** A booking as the agent reads it: its times, its room, its vet and its case. */
interface SlotRow {
  readonly id: string;
  readonly practiceId: string;
  readonly caseId: string;
  readonly roomId: string;
  readonly roomName: string;
  readonly vetId: string;
  readonly vetName: string;
  readonly kind: "procedure" | "consult";
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly patientName: string;
  readonly ownerName: string;
  readonly moneyState: MoneyState;
}

const slotColumns = {
  id: booking.id,
  practiceId: booking.practiceId,
  caseId: booking.caseId,
  roomId: booking.roomId,
  roomName: room.name,
  vetId: booking.vetId,
  vetName: vet.name,
  kind: booking.kind,
  startsAt: booking.startsAt,
  endsAt: booking.endsAt,
  patientName: patientCase.patientName,
  ownerName: patientCase.ownerName,
  moneyState: patientCase.moneyState,
};

/**
 * Holds one procedure's slot if the rule still says so under the case's
 * lock, and proposes moving the room's next procedure into it when the move
 * would fit.
 *
 * @param tx - The transaction.
 * @param bookingId - The procedure's booking.
 * @param now - The clock.
 * @returns The proposal made, or null when another sweep made it or the rule no longer holds.
 */
async function holdSlot(
  tx: Transaction,
  bookingId: string,
  now: Date,
): Promise<{ proposalId: string; moveProposed: boolean } | null> {
  const [due] = await tx
    .select({ ...slotColumns, leadMinutes: practice.scheduleLeadMinutes, zone: practice.timeZone })
    .from(booking)
    .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
    .innerJoin(room, eq(room.id, booking.roomId))
    .innerJoin(vet, eq(vet.id, booking.vetId))
    .innerJoin(practice, eq(practice.id, booking.practiceId))
    .where(eq(booking.id, bookingId))
    .for("share", { of: [patientCase, booking] });
  if (
    !due ||
    due.kind !== "procedure" ||
    due.moneyState !== "update_awaiting_owner" ||
    due.startsAt.getTime() <= now.getTime() ||
    due.startsAt.getTime() > now.getTime() + due.leadMinutes * MINUTE_MS
  ) {
    return null;
  }
  const [update] = await tx
    .select({ id: estimateVersion.id })
    .from(estimateVersion)
    .where(and(eq(estimateVersion.caseId, due.caseId), isNotNull(estimateVersion.sentAt)))
    .orderBy(desc(estimateVersion.number))
    .limit(1);
  if (!update) {
    return null;
  }
  const move = await moveThatFits(tx, due, due.zone);
  const reason = holdReason(firstName(due.ownerName), due.patientName);
  const [made] = await tx
    .insert(scheduleProposal)
    .values({
      practiceId: due.practiceId,
      caseId: due.caseId,
      bookingId: due.id,
      versionId: update.id,
      reason,
      heldAt: now,
      ...(move
        ? { moveBookingId: move.id, moveTo: due.startsAt, moveStatus: "proposed" as const }
        : {}),
    })
    .onConflictDoNothing()
    .returning({ id: scheduleProposal.id });
  if (!made) {
    return null;
  }
  const base = baseDetail(made.id, due);
  await appendAuditEvent(tx, {
    practiceId: due.practiceId,
    caseId: due.caseId,
    actor: "schedule_agent",
    action: "schedule.slot_held",
    detail: {
      ...base,
      versionId: update.id,
      startsAt: due.startsAt.toISOString(),
      endsAt: due.endsAt.toISOString(),
      leadMinutes: due.leadMinutes,
      reason,
    },
  });
  if (move) {
    await appendAuditEvent(tx, {
      practiceId: due.practiceId,
      caseId: due.caseId,
      actor: "schedule_agent",
      action: "schedule.move_proposed",
      detail: {
        ...base,
        moveBookingId: move.id,
        moveCaseId: move.caseId,
        moveFrom: move.startsAt.toISOString(),
        moveTo: due.startsAt.toISOString(),
        question: moveQuestion(move.patientName, minuteIn(due.zone, due.startsAt), due.patientName),
      },
    });
  }
  return { proposalId: made.id, moveProposed: move !== null };
}

/**
 * The room's next booking after a held procedure, when moving it into the
 * held slot (and the held procedure to follow it) would fit: it is a
 * procedure on the same day, its own case is not waiting on an update, no
 * hold or proposal already stands on it, and neither vet nor the room would
 * be in two places at once.
 *
 * @param tx - The transaction.
 * @param due - The held procedure.
 * @param zone - The practice's clock, for "the same day".
 * @returns The booking to move, or null.
 */
async function moveThatFits(tx: Transaction, due: SlotRow, zone: string): Promise<SlotRow | null> {
  const [next] = await tx
    .select(slotColumns)
    .from(booking)
    .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
    .innerJoin(room, eq(room.id, booking.roomId))
    .innerJoin(vet, eq(vet.id, booking.vetId))
    .where(
      and(
        eq(booking.roomId, due.roomId),
        ne(booking.id, due.id),
        gte(booking.startsAt, due.endsAt),
      ),
    )
    .orderBy(asc(booking.startsAt))
    .limit(1);
  if (
    !next ||
    next.kind !== "procedure" ||
    next.moneyState === "update_awaiting_owner" ||
    dayKeyIn(zone, next.startsAt) !== dayKeyIn(zone, due.startsAt)
  ) {
    return null;
  }
  const [taken] = await tx
    .select({ id: scheduleProposal.id })
    .from(scheduleProposal)
    .where(
      and(
        isNull(scheduleProposal.releasedAt),
        sql`(${scheduleProposal.bookingId} = ${next.id}
          or (${scheduleProposal.moveBookingId} = ${next.id} and ${scheduleProposal.moveStatus} = 'proposed'))`,
      ),
    )
    .limit(1);
  if (taken) {
    return null;
  }
  const swapped = swap(due, next);
  const clash = await clashOf(tx, swapped, [due.id, next.id]);
  return clash ? null : next;
}

/** Where a move puts the two bookings: the next one into the held slot, the held one after it. */
interface Swapped {
  readonly moved: { readonly vetId: string; readonly startsAt: Date; readonly endsAt: Date };
  readonly held: { readonly vetId: string; readonly startsAt: Date; readonly endsAt: Date };
  readonly roomId: string;
}

/**
 * The move's new times: the next procedure starts when the held one would
 * have, and the held one follows it, each keeping its length; together they
 * end no later than the next one did, so nothing else in the room is touched.
 *
 * @param held - The held procedure.
 * @param next - The room's next procedure.
 * @returns The new times.
 */
function swap(
  held: Pick<SlotRow, "vetId" | "startsAt" | "endsAt" | "roomId">,
  next: Pick<SlotRow, "vetId" | "startsAt" | "endsAt">,
): Swapped {
  const nextLength = next.endsAt.getTime() - next.startsAt.getTime();
  const heldLength = held.endsAt.getTime() - held.startsAt.getTime();
  const movedEnds = new Date(held.startsAt.getTime() + nextLength);
  return {
    roomId: held.roomId,
    moved: { vetId: next.vetId, startsAt: held.startsAt, endsAt: movedEnds },
    held: {
      vetId: held.vetId,
      startsAt: movedEnds,
      endsAt: new Date(movedEnds.getTime() + heldLength),
    },
  };
}

/**
 * What a move would double-book, apart from the two bookings it moves.
 *
 * @param tx - The transaction.
 * @param swapped - The move's new times.
 * @param moving - The two bookings it moves.
 * @returns The vet's name when a vet would be in two places, `room` for the room, or null.
 */
async function clashOf(
  tx: Transaction,
  swapped: Swapped,
  moving: readonly string[],
): Promise<{ vetName: string } | "room" | null> {
  for (const slot of [swapped.moved, swapped.held]) {
    const [busy] = await tx
      .select({ roomId: booking.roomId, vetId: booking.vetId, vetName: vet.name })
      .from(booking)
      .innerJoin(vet, eq(vet.id, slot.vetId))
      .where(
        and(
          notInArray(booking.id, [...moving]),
          lt(booking.startsAt, slot.endsAt),
          gt(booking.endsAt, slot.startsAt),
          sql`(${booking.vetId} = ${slot.vetId} or ${booking.roomId} = ${swapped.roomId})`,
        ),
      )
      .limit(1);
    if (busy) {
      return busy.vetId === slot.vetId ? { vetName: busy.vetName } : "room";
    }
  }
  return null;
}

/** A proposal as an action reads it under its lock, with its held booking. */
interface LockedProposal {
  readonly id: string;
  readonly practiceId: string;
  readonly releasedAt: Date | null;
  readonly moveBookingId: string | null;
  readonly moveTo: Date | null;
  readonly moveStatus: "proposed" | "applied" | "dismissed" | "withdrawn" | null;
  readonly due: SlotRow;
}

/**
 * Locks a proposal and reads its held booking.
 *
 * @param tx - The transaction.
 * @param proposalId - The proposal.
 * @param practiceId - The practice it must be, or any when the agent acts.
 * @returns The proposal, or null when the practice has none by that id.
 */
async function lockProposal(
  tx: Transaction,
  proposalId: string,
  practiceId?: string,
): Promise<LockedProposal | null> {
  const [locked] = await tx
    .select({
      id: scheduleProposal.id,
      practiceId: scheduleProposal.practiceId,
      releasedAt: scheduleProposal.releasedAt,
      moveBookingId: scheduleProposal.moveBookingId,
      moveTo: scheduleProposal.moveTo,
      moveStatus: scheduleProposal.moveStatus,
    })
    .from(scheduleProposal)
    .where(
      and(
        eq(scheduleProposal.id, proposalId),
        practiceId ? eq(scheduleProposal.practiceId, practiceId) : undefined,
      ),
    )
    .for("update");
  if (!locked) {
    return null;
  }
  const [due] = await tx
    .select(slotColumns)
    .from(scheduleProposal)
    .innerJoin(booking, eq(booking.id, scheduleProposal.bookingId))
    .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
    .innerJoin(room, eq(room.id, booking.roomId))
    .innerJoin(vet, eq(vet.id, booking.vetId))
    .where(eq(scheduleProposal.id, proposalId));
  return { ...locked, due: due! };
}

/**
 * The ids every schedule event carries (U8a's brief: the booking, the case
 * and the room).
 *
 * @param proposalId - The proposal.
 * @param due - Its held booking.
 * @returns The ids.
 */
function baseDetail(
  proposalId: string,
  due: Pick<SlotRow, "id" | "caseId" | "roomId">,
): Record<string, string> {
  return { proposalId, bookingId: due.id, caseId: due.caseId, roomId: due.roomId };
}

/**
 * Withdraws a proposal's move, as the agent, when one is still proposed.
 *
 * @param tx - The transaction.
 * @param proposal - The locked proposal.
 * @param now - The clock.
 * @param why - Why: the update answered, the hold undone, or the slot started.
 * @returns Whether a move was withdrawn.
 */
async function withdrawMove(
  tx: Transaction,
  proposal: LockedProposal,
  now: Date,
  why: "update_answered" | "slot_released" | "slot_started",
): Promise<boolean> {
  if (proposal.moveStatus !== "proposed") {
    return false;
  }
  await tx
    .update(scheduleProposal)
    .set({ moveStatus: "withdrawn", moveDecidedAt: now })
    .where(eq(scheduleProposal.id, proposal.id));
  await appendAuditEvent(tx, {
    practiceId: proposal.practiceId,
    caseId: proposal.due.caseId,
    actor: "schedule_agent",
    action: "schedule.proposal_withdrawn",
    detail: {
      ...baseDetail(proposal.id, proposal.due),
      moveBookingId: proposal.moveBookingId,
      why,
    },
  });
  return true;
}

/**
 * Releases a hold, by the agent once its update was answered or by the
 * practice's click, withdrawing a move still proposed.
 *
 * @param tx - The transaction.
 * @param proposal - The locked, open proposal.
 * @param now - The clock.
 * @param by - Who released it.
 * @returns Whether a move was withdrawn with it.
 */
async function release(
  tx: Transaction,
  proposal: LockedProposal,
  now: Date,
  by: "practice" | "agent",
): Promise<boolean> {
  const withdrawn = await withdrawMove(
    tx,
    proposal,
    now,
    by === "agent" ? "update_answered" : "slot_released",
  );
  await tx
    .update(scheduleProposal)
    .set({ releasedAt: now, releasedBy: by })
    .where(eq(scheduleProposal.id, proposal.id));
  const [state] = await tx
    .select({ moneyState: patientCase.moneyState })
    .from(patientCase)
    .where(eq(patientCase.id, proposal.due.caseId));
  await appendAuditEvent(tx, {
    practiceId: proposal.practiceId,
    caseId: proposal.due.caseId,
    actor: by === "agent" ? "schedule_agent" : "vet",
    action: "schedule.slot_released",
    detail: {
      ...baseDetail(proposal.id, proposal.due),
      by,
      why: by === "agent" ? "update_answered" : "undone",
      moneyState: state!.moneyState,
    },
  });
  return withdrawn;
}

/**
 * Releases a hold whose update was answered, if it still is under the lock.
 *
 * @param tx - The transaction.
 * @param proposalId - The proposal.
 * @param now - The clock.
 * @returns What was done.
 */
async function releaseAnswered(
  tx: Transaction,
  proposalId: string,
  now: Date,
): Promise<{ released: boolean; withdrawn: boolean }> {
  const proposal = await lockProposal(tx, proposalId);
  if (!proposal || proposal.releasedAt !== null) {
    return { released: false, withdrawn: false };
  }
  const [still] = await tx
    .select({ id: scheduleProposal.id })
    .from(scheduleProposal)
    .innerJoin(patientCase, eq(patientCase.id, scheduleProposal.caseId))
    .where(
      and(
        eq(scheduleProposal.id, proposalId),
        eq(patientCase.moneyState, "update_awaiting_owner"),
        sql`(select ${estimateVersion.id} from ${estimateVersion}
          where ${estimateVersion.caseId} = ${scheduleProposal.caseId}
            and ${estimateVersion.sentAt} is not null
          order by ${estimateVersion.number} desc limit 1) = ${scheduleProposal.versionId}`,
      ),
    );
  if (still) {
    return { released: false, withdrawn: false };
  }
  const withdrawn = await release(tx, proposal, now, "agent");
  return { released: true, withdrawn };
}

/**
 * Withdraws a move whose held slot has started, if it still is proposed.
 *
 * @param tx - The transaction.
 * @param proposalId - The proposal.
 * @param now - The clock.
 * @returns Whether it was withdrawn.
 */
async function withdrawStarted(tx: Transaction, proposalId: string, now: Date): Promise<boolean> {
  const proposal = await lockProposal(tx, proposalId);
  if (
    !proposal ||
    proposal.releasedAt !== null ||
    proposal.moveTo === null ||
    proposal.moveTo.getTime() > now.getTime()
  ) {
    return false;
  }
  return withdrawMove(tx, proposal, now, "slot_started");
}

/** What the practice's click on a proposal names: the practice signed in, the proposal and the clock. */
export const proposalAction = z.strictObject({
  practiceId: z.uuid(),
  proposalId: z.uuid(),
  now: z.date().optional(),
});

export type ProposalAction = z.input<typeof proposalAction>;

/**
 * Runs one of the practice's clicks on a proposal under its lock.
 *
 * @param db - The database.
 * @param request - The practice, the proposal and the clock.
 * @param act - The click's change.
 * @returns Resolves once done.
 * @throws ScheduleError `request_invalid`, `proposal_not_found`, or the click's own refusal.
 */
async function onProposal(
  db: Database["db"],
  request: ProposalAction,
  act: (tx: Transaction, proposal: LockedProposal, now: Date) => Promise<void>,
): Promise<void> {
  const parsed = proposalAction.safeParse(request);
  if (!parsed.success) {
    throw new ScheduleError("request_invalid", "That proposal is not this practice's.");
  }
  const { practiceId, proposalId } = parsed.data;
  const now = parsed.data.now ?? new Date();
  await db.transaction(async (tx) => {
    const proposal = await lockProposal(tx, proposalId, practiceId);
    if (!proposal) {
      throw new ScheduleError("proposal_not_found", "That proposal is not this practice's.");
    }
    await act(tx, proposal, now);
  });
}

/**
 * "Move it" (section 6): applies a proposed move, the only way a move is ever
 * made (D9 (a)). The next procedure takes the held slot and the held one
 * follows it; the database checks at commit that no room or vet is booked
 * twice.
 *
 * @param db - The database.
 * @param request - The practice, the proposal and the clock.
 * @returns Resolves once moved.
 * @throws ScheduleError `hold_released`, `move_not_open`, `move_too_late` (the held slot has started), `move_stale` (a booking changed since it was proposed) or `move_clash`.
 */
export async function applyMove(db: Database["db"], request: ProposalAction): Promise<void> {
  try {
    await onProposal(db, request, async (tx, proposal, now) => {
      if (proposal.releasedAt !== null) {
        throw new ScheduleError("hold_released", "That hold was already undone.");
      }
      if (
        proposal.moveStatus !== "proposed" ||
        proposal.moveBookingId === null ||
        proposal.moveTo === null
      ) {
        throw new ScheduleError("move_not_open", "That move is no longer proposed.");
      }
      if (now.getTime() >= proposal.moveTo.getTime()) {
        throw new ScheduleError(
          "move_too_late",
          "That slot has started, so the move can no longer be made.",
        );
      }
      const [next] = await tx
        .select(slotColumns)
        .from(booking)
        .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
        .innerJoin(room, eq(room.id, booking.roomId))
        .innerJoin(vet, eq(vet.id, booking.vetId))
        .where(eq(booking.id, proposal.moveBookingId))
        .for("update", { of: booking });
      await tx
        .select({ id: booking.id })
        .from(booking)
        .where(eq(booking.id, proposal.due.id))
        .for("update");
      if (
        !next ||
        proposal.due.startsAt.getTime() !== proposal.moveTo.getTime() ||
        next.roomId !== proposal.due.roomId ||
        next.startsAt.getTime() < proposal.due.endsAt.getTime()
      ) {
        throw new ScheduleError(
          "move_stale",
          "The day changed since that move was proposed. Look again before moving.",
        );
      }
      const swapped = swap(proposal.due, next);
      const clash = await clashOf(tx, swapped, [proposal.due.id, next.id]);
      if (clash === "room") {
        throw new ScheduleError("move_clash", `That move would double-book ${next.roomName}.`);
      }
      if (clash) {
        throw new ScheduleError(
          "move_clash",
          `That move would put ${clash.vetName} in two places at once.`,
        );
      }
      await tx
        .update(booking)
        .set({ ...swapped.moved, updatedAt: now })
        .where(eq(booking.id, next.id));
      await tx
        .update(booking)
        .set({ ...swapped.held, updatedAt: now })
        .where(eq(booking.id, proposal.due.id));
      await tx
        .update(scheduleProposal)
        .set({ moveStatus: "applied", moveDecidedAt: now })
        .where(eq(scheduleProposal.id, proposal.id));
      await appendAuditEvent(tx, {
        practiceId: proposal.practiceId,
        caseId: proposal.due.caseId,
        actor: "vet",
        action: "schedule.move_applied",
        detail: {
          ...baseDetail(proposal.id, proposal.due),
          moveBookingId: next.id,
          moveCaseId: next.caseId,
          moved: {
            from: next.startsAt.toISOString(),
            to: swapped.moved.startsAt.toISOString(),
          },
          heldMoved: {
            from: proposal.due.startsAt.toISOString(),
            to: swapped.held.startsAt.toISOString(),
          },
        },
      });
    });
  } catch (error) {
    const broken = brokenScheduleConstraint(error);
    if (broken === "booking_vet_free") {
      throw new ScheduleError("move_clash", "That move would put a vet in two places at once.");
    }
    if (broken === "booking_room_free") {
      throw new ScheduleError("move_clash", "That move would double-book the room.");
    }
    throw error;
  }
}

/**
 * "Dismiss" (section 6): the practice declines the proposed move; the hold stands.
 *
 * @param db - The database.
 * @param request - The practice, the proposal and the clock.
 * @returns Resolves once dismissed.
 * @throws ScheduleError `move_not_open` when no move is proposed.
 */
export async function dismissMove(db: Database["db"], request: ProposalAction): Promise<void> {
  await onProposal(db, request, async (tx, proposal, now) => {
    if (proposal.releasedAt !== null || proposal.moveStatus !== "proposed") {
      throw new ScheduleError("move_not_open", "That move is no longer proposed.");
    }
    await tx
      .update(scheduleProposal)
      .set({ moveStatus: "dismissed", moveDecidedAt: now })
      .where(eq(scheduleProposal.id, proposal.id));
    await appendAuditEvent(tx, {
      practiceId: proposal.practiceId,
      caseId: proposal.due.caseId,
      actor: "vet",
      action: "schedule.proposal_dismissed",
      detail: { ...baseDetail(proposal.id, proposal.due), moveBookingId: proposal.moveBookingId },
    });
  });
}

/**
 * "Undo" (section 6): one click releases the agent's hold (D9 (a)), and
 * withdraws its move if still proposed. The agent does not hold the slot
 * again for the same update.
 *
 * @param db - The database.
 * @param request - The practice, the proposal and the clock.
 * @returns Resolves once released.
 * @throws ScheduleError `hold_released` when it was already released.
 */
export async function releaseHold(db: Database["db"], request: ProposalAction): Promise<void> {
  await onProposal(db, request, async (tx, proposal, now) => {
    if (proposal.releasedAt !== null) {
      throw new ScheduleError("hold_released", "That hold was already undone.");
    }
    await release(tx, proposal, now, "practice");
  });
}
