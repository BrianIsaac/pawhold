"use server";

import { revalidatePath } from "next/cache";

import {
  applyMove,
  dismissMove,
  type ProposalAction,
  releaseHold,
  sweepSchedule,
} from "@/schedule/agent";
import { ScheduleError } from "@/schedule/errors";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

import type { FormState } from "../form-state";

/** What a form says when the visitor's session has gone. */
const SESSION_ENDED = "Your session has ended. Reload the page to start a new one.";

/** What one on-demand check of the day answers. */
export interface DayCheck {
  /** When the agent checked the day, ISO 8601; null when the session has gone. */
  readonly checkedAt: string | null;
  /** Whether the check held, released or withdrew anything. */
  readonly changed: boolean;
}

/**
 * The schedule agent, on demand (U8a's brief, item 3): sweeps the signed-in
 * practice's day as the hourly job sweeps every practice's, so a slot inside
 * the lead time is held while the day is open rather than at the next hour.
 * The day is shown afresh either way, so a case the owner answered meanwhile
 * shows its new state.
 *
 * @returns When it checked, and whether anything changed.
 */
export async function checkTheDayAction(): Promise<DayCheck> {
  const session = await currentPracticeSession();
  if (!session) {
    return { checkedAt: null, changed: false };
  }
  const now = new Date();
  const report = await sweepSchedule(database().db, { practiceId: session.practiceId, now });
  revalidatePath("/day");
  return {
    checkedAt: now.toISOString(),
    changed: report.held.length + report.released.length + report.withdrawn.length > 0,
  };
}

/**
 * Runs one of the practice's clicks on a proposal for the signed-in practice,
 * turning a refusal into the button's message and showing the day afresh.
 * The proposal's id comes bound from the page; the click checks it is the
 * practice's.
 *
 * @param proposalId - The proposal the button is on.
 * @param act - The click.
 * @returns The button's state.
 */
async function onProposal(
  proposalId: string,
  act: (db: ReturnType<typeof database>["db"], request: ProposalAction) => Promise<void>,
): Promise<FormState> {
  const session = await currentPracticeSession();
  if (!session) {
    return { message: SESSION_ENDED, fields: {}, values: {} };
  }
  try {
    await act(database().db, { practiceId: session.practiceId, proposalId });
  } catch (error) {
    if (!(error instanceof ScheduleError)) {
      throw error;
    }
    revalidatePath("/day");
    return { message: error.message, fields: {}, values: {} };
  }
  revalidatePath("/day");
  return { message: null, fields: {}, values: {} };
}

/**
 * "Move it" (section 6): the practice's click that alone makes the agent's move (D9 (a)).
 *
 * @param proposalId - The proposal.
 * @returns The button's state.
 */
export async function moveItAction(proposalId: string): Promise<FormState> {
  return onProposal(proposalId, applyMove);
}

/**
 * "Dismiss" (section 6): the practice declines the move; the hold stands.
 *
 * @param proposalId - The proposal.
 * @returns The button's state.
 */
export async function dismissMoveAction(proposalId: string): Promise<FormState> {
  return onProposal(proposalId, dismissMove);
}

/**
 * "Undo" (section 6): one click releases the agent's hold (D9 (a)).
 *
 * @param proposalId - The proposal.
 * @returns The button's state.
 */
export async function undoHoldAction(proposalId: string): Promise<FormState> {
  return onProposal(proposalId, releaseHold);
}
