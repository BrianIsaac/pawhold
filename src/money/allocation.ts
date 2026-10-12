import { MoneyError } from "./errors";

/**
 * A hold as the allocation sees it: its amount, and what its owner approved
 * by price list code (the items the hold's version added or raised over the
 * version held before it).
 */
export interface AllocatableHold {
  readonly id: string;
  readonly amountPence: number;
  /** Pence approved under this hold, by item code. */
  readonly approved: ReadonlyMap<string, number>;
}

/** A bill line's money and the item it is for. */
export interface BillAmount {
  readonly code: string;
  readonly amountPence: number;
}

/** The part of one bill line one hold pays. */
export interface Allocation {
  /** The bill line's place in the bill, from 0. */
  readonly line: number;
  readonly holdId: string;
  readonly amountPence: number;
}

/** A bill allocated to holds. */
export interface AllocationPlan {
  /** Each bill line's parts, in the bill's order. */
  readonly byLine: readonly (readonly Allocation[])[];
  /** What each hold pays, by hold id; a hold that pays nothing is absent. */
  readonly byHold: ReadonlyMap<string, number>;
  readonly billedPence: number;
  readonly heldPence: number;
  /** What the holds hold beyond the bill: released to the owner. */
  readonly releasedPence: number;
}

/** A version an authorised hold was made for: its items' tops, in the order the holds were made. */
export interface HeldVersion {
  readonly holdId: string;
  readonly items: readonly { readonly code: string; readonly highPence: number }[];
}

/**
 * The holds a run of approved versions makes, each with what its owner
 * approved: the first version's items whole, and each later version's items
 * as far as they rise above the version before. A hold's amount is its
 * version's top less the one before (D3); a version that adds nothing over
 * what is held makes no hold.
 *
 * @param versions - The versions, in the order their holds were made.
 * @returns The holds, in the same order.
 */
export function approvalsByHold(versions: readonly HeldVersion[]): AllocatableHold[] {
  const holds: AllocatableHold[] = [];
  let before = new Map<string, number>();
  let heldPence = 0;
  for (const version of versions) {
    const now = topsByCode(version.items);
    const top = [...now.values()].reduce((sum, pence) => sum + pence, 0);
    if (top <= heldPence) {
      continue;
    }
    const approved = new Map<string, number>();
    for (const [code, pence] of now) {
      const rise = pence - (before.get(code) ?? 0);
      if (rise > 0) {
        approved.set(code, rise);
      }
    }
    holds.push({ id: version.holdId, amountPence: top - heldPence, approved });
    heldPence = top;
    before = now;
  }
  return holds;
}

/**
 * A version's items summed by code.
 *
 * @param items - The items.
 * @returns Each code's top.
 */
function topsByCode(
  items: readonly { readonly code: string; readonly highPence: number }[],
): Map<string, number> {
  const byCode = new Map<string, number>();
  for (const item of items) {
    byCode.set(item.code, (byCode.get(item.code) ?? 0) + item.highPence);
  }
  return byCode;
}

/**
 * Allocates a bill's lines to a case's holds (plan 3.2, rule 2): each line
 * goes first to the holds whose owners approved its item, in the order the
 * holds were made, up to what each approved, so an update's new lines are
 * paid from the update's hold and an item an update raised from the first
 * hold up to what it approved, then the update's; what is left of a line
 * (an item approved under a version since cut back) goes to the holds with
 * room, in the order they were made. No hold pays past its amount (rule 1),
 * so a bill above the holds is refused whole.
 *
 * @param holds - The case's authorised holds, in the order they were made.
 * @param lines - The bill's lines, in the bill's order.
 * @returns The allocation.
 * @throws MoneyError when the bill is above what the holds hold.
 */
export function allocateBill(
  holds: readonly AllocatableHold[],
  lines: readonly BillAmount[],
): AllocationPlan {
  const heldPence = holds.reduce((sum, one) => sum + one.amountPence, 0);
  const billedPence = lines.reduce((sum, line) => sum + line.amountPence, 0);
  if (billedPence > heldPence) {
    throw new MoneyError(
      "bill_above_holds",
      `the bill is ${billedPence} pence and the holds hold ${heldPence}: nothing above a hold is captured; send an update for the rest`,
    );
  }

  const room = new Map(holds.map((one) => [one.id, one.amountPence]));
  const approvedLeft = new Map(holds.map((one) => [one.id, new Map(one.approved)]));
  const parts: Allocation[][] = lines.map(() => []);
  const left = lines.map((line) => line.amountPence);

  const take = (line: number, holdId: string, most: number) => {
    const amountPence = Math.min(left[line]!, most, room.get(holdId)!);
    if (amountPence <= 0) {
      return;
    }
    const existing = parts[line]!.findIndex((part) => part.holdId === holdId);
    if (existing >= 0) {
      const before = parts[line]![existing]!;
      parts[line]![existing] = { ...before, amountPence: before.amountPence + amountPence };
    } else {
      parts[line]!.push({ line, holdId, amountPence });
    }
    left[line] = left[line]! - amountPence;
    room.set(holdId, room.get(holdId)! - amountPence);
    return amountPence;
  };

  lines.forEach((line, at) => {
    for (const one of holds) {
      const approved = approvedLeft.get(one.id)!;
      const taken = take(at, one.id, approved.get(line.code) ?? 0);
      if (taken) {
        approved.set(line.code, approved.get(line.code)! - taken);
      }
    }
  });
  lines.forEach((_, at) => {
    for (const one of holds) {
      take(at, one.id, Number.POSITIVE_INFINITY);
    }
  });

  const byHold = new Map<string, number>();
  for (const part of parts.flat()) {
    byHold.set(part.holdId, (byHold.get(part.holdId) ?? 0) + part.amountPence);
  }
  return { byLine: parts, byHold, billedPence, heldPence, releasedPence: heldPence - billedPence };
}
