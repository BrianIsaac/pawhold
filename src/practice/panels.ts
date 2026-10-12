import { findSpan } from "@/agent/guardrails";
import type { EstimateVersionView } from "@/estimate/version";
import type { HoldView } from "@/money/view";

import type { LineSpan } from "./highlight";
import type { SourceView } from "./sources";

/** A version as a panel of the case page shows it: its lines, its words, and where each line came from. */
export interface VersionPanel {
  readonly version: EstimateVersionView;
  readonly source: SourceView | null;
  /** Where each line's span sits in the source's words; lines with none found are left out. */
  readonly spans: readonly LineSpan[];
}

/**
 * The sent versions the owner approved: each one a hold was authorised for
 * (still held, captured, released or expired), in order.
 *
 * @param sent - The case's sent versions, in order.
 * @param holds - The case's holds.
 * @returns The approved versions.
 */
export function approvedVersions(
  sent: readonly EstimateVersionView[],
  holds: readonly HoldView[],
): EstimateVersionView[] {
  const authorised = new Set(
    holds.filter((hold) => hold.authorisedAt !== null).map((hold) => hold.id),
  );
  return sent.filter((version) => authorised.has(version.id));
}

/**
 * A version's panel: its lines' spans found in its source's words. An
 * update's source is the vet's finding, so only the lines it added (from
 * `from`, the count of lines before it) are looked for in it.
 *
 * @param version - The version.
 * @param source - The words it was drafted from, if any.
 * @param from - How many of its first lines came from an earlier version.
 * @returns The panel.
 */
export function versionPanel(
  version: EstimateVersionView,
  source: SourceView | null,
  from = 0,
): VersionPanel {
  const spans: LineSpan[] = [];
  if (source) {
    for (const line of version.lines.slice(from)) {
      const found = line.notesSpan === null ? null : findSpan(source.text, line.notesSpan);
      if (found) {
        spans.push({ position: line.position, start: found.start, end: found.end });
      }
    }
  }
  return { version, source, spans };
}

/**
 * What the review dialog shows of a draft, bound into its send so the send
 * approves exactly that (U2 rewrites every line's id on any change).
 *
 * @param version - The draft as rendered.
 * @returns Its totals and its lines' ids.
 */
export function reviewedOf(version: EstimateVersionView): {
  lowPence: number;
  highPence: number;
  lineIds: string[];
} {
  return {
    lowPence: version.totals.lowPence,
    highPence: version.totals.highPence,
    lineIds: version.lines.map((line) => line.id),
  };
}
