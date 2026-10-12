/** Where one line's span sits in the words it came from (UTF-16 offsets, end exclusive). */
export interface LineSpan {
  readonly position: number;
  readonly start: number;
  readonly end: number;
}

/** A run of the words: plain when it names no line, marked with the lines it came from otherwise. */
export interface HighlightSegment {
  readonly text: string;
  /** The positions of the lines this run is the span of, in order; empty for plain text. */
  readonly positions: readonly number[];
}

/**
 * Cuts the vet's words into plain runs and marked spans, so each drafted
 * line's span is highlighted where it sits. Spans that overlap or repeat (two
 * lines from one phrase) become one mark naming every line it is the span of.
 *
 * @param text - The notes or the finding.
 * @param spans - Each line's span in them.
 * @returns The runs, in order, covering the whole text.
 */
export function highlightSegments(text: string, spans: readonly LineSpan[]): HighlightSegment[] {
  const sorted = spans
    .filter((span) => span.start >= 0 && span.end <= text.length && span.start < span.end)
    .toSorted((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number; positions: Set<number> }[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      last.positions.add(span.position);
    } else {
      merged.push({ start: span.start, end: span.end, positions: new Set([span.position]) });
    }
  }
  const segments: HighlightSegment[] = [];
  let at = 0;
  for (const mark of merged) {
    if (mark.start > at) {
      segments.push({ text: text.slice(at, mark.start), positions: [] });
    }
    segments.push({
      text: text.slice(mark.start, mark.end),
      positions: [...mark.positions].toSorted((a, b) => a - b),
    });
    at = mark.end;
  }
  if (at < text.length || segments.length === 0) {
    segments.push({ text: text.slice(at), positions: [] });
  }
  return segments;
}
