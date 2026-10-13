/** What the open day remembers between answers: the stamp it last read the day again for, and the answers since. */
export interface LiveMemory {
  readonly asked: string | null;
  readonly answers: number;
}

/** Nothing asked for yet. */
export const FRESH: LiveMemory = { asked: null, answers: 0 };

/**
 * How many answers a read of the day is given to arrive before it is asked
 * for again: a read can be dropped (the network, or another read in flight),
 * and the stamp alone would never ask twice.
 */
export const READ_AGAIN_AFTER = 3;

/**
 * What the open day does with one answer to "has anything changed?" (U8b):
 * nothing while the stamp is the one the page was drawn from; a read of the
 * day when it has moved, once for each stamp; and the read again when the
 * page still is not drawn from that stamp {@link READ_AGAIN_AFTER} answers
 * later.
 *
 * @param memory - What the day remembers of its last read.
 * @param drawn - The stamp the page was drawn from.
 * @param latest - The stamp just answered.
 * @returns Whether to read the day again, and what to remember.
 */
export function liveStep(
  memory: LiveMemory,
  drawn: string,
  latest: string,
): { read: boolean; memory: LiveMemory } {
  if (latest === drawn) {
    return { read: false, memory: FRESH };
  }
  if (memory.asked !== latest) {
    return { read: true, memory: { asked: latest, answers: 0 } };
  }
  const answers = memory.answers + 1;
  return answers >= READ_AGAIN_AFTER
    ? { read: true, memory: { asked: latest, answers: 0 } }
    : { read: false, memory: { asked: latest, answers } };
}
