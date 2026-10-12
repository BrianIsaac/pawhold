/** What a line is, for telling whether an update changed it. */
export interface ComparedLine {
  readonly code: string;
  readonly quantityLow: number;
  readonly quantityHigh: number;
  readonly ownerWording: string | null;
  readonly dependsOn: string | null;
}

/**
 * The lines a version added or changed over the version before it, in the
 * version's order (U11). Each line of the version before is matched once, to
 * the first line of the new version that is its twin (the same item, the same
 * quantities, the same words for the owner and the same condition); every
 * line left unmatched is new or changed. U2's delta is by item code, so an
 * update that adds a second line of an item the estimate already had (a
 * second lump removed) would otherwise show both lines of that code as added.
 *
 * @param before - The lines of the version before (the one the owner approved).
 * @param after - The lines of the new version.
 * @returns The new version's lines that the version before had no twin of.
 */
export function linesAdded<L extends ComparedLine>(
  before: readonly ComparedLine[],
  after: readonly L[],
): L[] {
  const left = new Map<string, number>();
  for (const one of before) {
    left.set(twinKey(one), (left.get(twinKey(one)) ?? 0) + 1);
  }
  return after.filter((one) => {
    const key = twinKey(one);
    const unmatched = left.get(key) ?? 0;
    if (unmatched > 0) {
      left.set(key, unmatched - 1);
      return false;
    }
    return true;
  });
}

/**
 * The key two lines share when one is the other carried over unchanged.
 *
 * @param line - The line.
 * @returns The key.
 */
function twinKey(line: ComparedLine): string {
  return JSON.stringify([
    line.code,
    line.quantityLow,
    line.quantityHigh,
    line.ownerWording,
    line.dependsOn,
  ]);
}
