import type { z } from "zod";

import { estimateLineInput, type EstimateLineInput, MAX_VERSION_LINES } from "@/estimate/version";

import { draftedLine, toEstimateLine, unmatchedSpan } from "./schema";

/**
 * The code checks of plan 3.4, run on every answer before anything reaches a
 * version. A rule that code can enforce is never left to the prompt: every
 * code must be on the list, every span must be in the notes, and the owner's
 * wording may carry no money, percentage or dose.
 */

/** What a guardrail needs of a price list item. */
export interface GuardItem {
  readonly name: string;
}

/** Why an owner's wording was replaced by the item's own name. */
export type OwnerWordingFault = "currency" | "percentage" | "dose";

/** A line that passed every check, its span as the notes wrote it. */
export interface KeptLine {
  readonly line: EstimateLineInput & { readonly notesSpan: string; readonly ownerWording: string };
  /** Where the span starts in the notes (a UTF-16 index). */
  readonly start: number;
  /** Where the span ends in the notes, exclusive. */
  readonly end: number;
  /** Why the model's wording was replaced by the item's name, or null when it was kept. */
  readonly ownerWordingFellBack: OwnerWordingFault | null;
}

/** A span of the notes no price list item matched: "add one by hand". */
export interface UnmatchedSpan {
  readonly notesSpan: string;
  readonly start: number;
  readonly end: number;
  /** The code the model gave that is not on the list, or null when it named none. */
  readonly code: string | null;
}

/** Why a line the model drafted was left out. */
export type UnsupportedReason = "span_not_in_notes" | "invalid_line" | "too_many_lines";

/** A line the model drafted that was left out, shown to the vet as unsupported. */
export interface UnsupportedLine {
  readonly reason: UnsupportedReason;
  readonly code: string | null;
  readonly notesSpan: string | null;
  readonly message: string;
}

/** An answer's lines after the guardrails. */
export interface GuardedLines {
  readonly kept: readonly KeptLine[];
  readonly unmatched: readonly UnmatchedSpan[];
  readonly unsupported: readonly UnsupportedLine[];
}

/** A span found in the notes. */
export interface FoundSpan {
  readonly start: number;
  readonly end: number;
  /** The notes' own text between `start` and `end`. */
  readonly text: string;
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * Finds a span verbatim in the notes. Runs of whitespace match any run of
 * whitespace (a pasted line break against a space), case is exact, and the
 * match may not start or end inside a word ("GA" is not found in "GAstric").
 * A span of no letters or digits is never found.
 *
 * @param notes - The vet's notes.
 * @param span - The span the model quoted.
 * @returns Where it is in the notes, or null when it is not there.
 */
export function findSpan(notes: string, span: string): FoundSpan | null {
  const wanted = span.trim().replace(/\s+/g, " ");
  if (!WORD.test(wanted)) {
    return null;
  }
  const origin: number[] = [];
  let flat = "";
  for (let at = 0; at < notes.length; at += 1) {
    const char = notes[at]!;
    if (/\s/.test(char)) {
      if (!flat.endsWith(" ")) {
        flat += " ";
        origin.push(at);
      }
    } else {
      flat += char;
      origin.push(at);
    }
  }
  const opensWord = WORD.test(wanted[0]!);
  const closesWord = WORD.test(wanted[wanted.length - 1]!);
  for (let from = 0; ;) {
    const at = flat.indexOf(wanted, from);
    if (at < 0) {
      return null;
    }
    const before = flat[at - 1];
    const after = flat[at + wanted.length];
    const clean =
      !(opensWord && before !== undefined && WORD.test(before)) &&
      !(closesWord && after !== undefined && WORD.test(after));
    if (clean) {
      const start = origin[at]!;
      const end = origin[at + wanted.length - 1]! + 1;
      return { start, end, text: notes.slice(start, end) };
    }
    from = at + 1;
  }
}

const CURRENCY = [
  /[£$€¥]/,
  /\b\d+(?:\.\d+)?\s?p\b/,
  /\b(?:GBP|USD|EUR|pounds?|pence|quid|dollars?|euros?)\b/i,
  /(?<!\bper\s?)\bcents?\b/i,
];

const PERCENTAGE = [/%/, /\bper\s?cent\b/i, /\bpercent(?:age)?\b/i];

const DOSE = [
  /\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|μg|ug|ng|g|ml|mL|cc|l|L|iu|IU|units?|mmol|mEq|meq)\b/,
  /\b(?:mg|mcg|µg|μg|ml|mL|iu|IU)\s*\/\s*(?:kg|day|d|h|hr|hour)\b/,
  /\b\d+(?:[.,]\d+)?\s*(?:tablets?|tabs?|capsules?|caps?|drops?|sachets?|puffs?|pumps?)\b/i,
  /\b(?:SID|BID|BD|TID|TDS|QID|QDS|EOD|PRN|q\d+h)\b/,
  /\b(?:once|twice|\d+\s+times|(?:three|four)\s+times)\s+(?:a|per|every)\s+day\b/i,
];

/**
 * Checks an owner's wording for what plan 3.4 forbids in it: a currency
 * amount, a percentage or a dose. Money is only ever shown by code.
 *
 * @param wording - The wording.
 * @returns What it carries that it may not, or null when it is clean.
 */
export function checkOwnerWording(wording: string): OwnerWordingFault | null {
  if (PERCENTAGE.some((pattern) => pattern.test(wording))) {
    return "percentage";
  }
  if (CURRENCY.some((pattern) => pattern.test(wording))) {
    return "currency";
  }
  if (DOSE.some((pattern) => pattern.test(wording))) {
    return "dose";
  }
  return null;
}

/** Why the owner's explanation of an update was not shown. */
export type ExplanationFault = OwnerWordingFault | "new_number" | "empty";

const NUMBER = /\d+(?:[.,]\d+)?/g;

/**
 * Checks the owner's explanation of an update (plan 3.4, job 2: it
 * "rephrases the vet's note and nothing else"). What code can check, it does:
 * no money, percentage or dose, and no figure the vet did not write. Whether
 * it adds a diagnosis or advice in words is for the vet's review and the
 * eval; the owner always sees the vet's own words beside it.
 *
 * @param explanation - The model's explanation.
 * @param vetNote - The vet's own words.
 * @returns Why it may not be shown, or null when it may.
 */
export function checkExplanation(explanation: string, vetNote: string): ExplanationFault | null {
  if (explanation.trim() === "") {
    return "empty";
  }
  const fault = checkOwnerWording(explanation);
  if (fault) {
    return fault;
  }
  const written = new Set(vetNote.match(NUMBER) ?? []);
  return (explanation.match(NUMBER) ?? []).every((number) => written.has(number))
    ? null
    : "new_number";
}

/**
 * Runs the guardrails over an answer's lines and its unmatched spans: a line
 * malformed, with its span not in the notes, or beyond a version's size is
 * left out as unsupported; a line whose code is not on the list is left out
 * and its span shown as unmatched; a line's owner's wording that carries money,
 * a percentage or a dose falls back to the item's own name.
 *
 * @param lines - The answer's lines, as the model gave them.
 * @param unmatched - The spans the model said no item matched.
 * @param notes - The vet's notes (or finding) the spans must come from.
 * @param items - The practice's price list items by code.
 * @returns What was kept, what is unmatched and what was left out.
 */
export function guardLines(
  lines: readonly unknown[],
  unmatched: readonly unknown[],
  notes: string,
  items: ReadonlyMap<string, GuardItem>,
): GuardedLines {
  const kept: KeptLine[] = [];
  const spans: UnmatchedSpan[] = [];
  const unsupported: UnsupportedLine[] = [];

  lines.forEach((raw, at) => {
    const given = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const code = typeof given.code === "string" ? given.code : null;
    const quoted = typeof given.notesSpan === "string" ? given.notesSpan : null;
    const drafted = draftedLine.safeParse(raw);
    const input = drafted.success
      ? estimateLineInput.safeParse(toEstimateLine(drafted.data))
      : null;
    if (!drafted.success || !input?.success) {
      const issues = drafted.success ? input!.error!.issues : drafted.error.issues;
      unsupported.push({
        reason: "invalid_line",
        code,
        notesSpan: quoted,
        message: `the draft's line ${at + 1} was not a well-formed line: ${firstIssue(issues)}`,
      });
      return;
    }
    const line = drafted.data;
    const found = findSpan(notes, line.notesSpan);
    if (!found) {
      unsupported.push({
        reason: "span_not_in_notes",
        code: line.code,
        notesSpan: line.notesSpan,
        message: `the draft quoted "${line.notesSpan}", which is not in the notes`,
      });
      return;
    }
    const item = items.get(line.code);
    if (!item) {
      spans.push({ notesSpan: found.text, start: found.start, end: found.end, code: line.code });
      return;
    }
    if (kept.length === MAX_VERSION_LINES) {
      unsupported.push({
        reason: "too_many_lines",
        code: line.code,
        notesSpan: found.text,
        message: `a version holds at most ${MAX_VERSION_LINES} lines`,
      });
      return;
    }
    const fault = checkOwnerWording(line.ownerWording);
    kept.push({
      line: {
        ...toEstimateLine(line),
        notesSpan: found.text,
        ownerWording: fault === null ? line.ownerWording : item.name,
      },
      start: found.start,
      end: found.end,
      ownerWordingFellBack: fault,
    });
  });

  for (const raw of unmatched) {
    const parsed = unmatchedSpan.safeParse(raw);
    if (!parsed.success) {
      unsupported.push({
        reason: "invalid_line",
        code: null,
        notesSpan: null,
        message: `an unmatched span was not well formed: ${firstIssue(parsed.error.issues)}`,
      });
      continue;
    }
    const found = findSpan(notes, parsed.data.notesSpan);
    if (!found) {
      unsupported.push({
        reason: "span_not_in_notes",
        code: null,
        notesSpan: parsed.data.notesSpan,
        message: `the draft quoted "${parsed.data.notesSpan}", which is not in the notes`,
      });
      continue;
    }
    spans.push({ notesSpan: found.text, start: found.start, end: found.end, code: null });
  }

  const seen = new Set<string>();
  const distinct = spans
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .filter((span) => {
      const key = `${span.start}:${span.end}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
  return { kept, unmatched: distinct, unsupported };
}

/**
 * The first issue of a failed parse, in words.
 *
 * @param issues - The parse's issues.
 * @returns The first, with its path.
 */
function firstIssue(issues: readonly z.core.$ZodIssue[]): string {
  const [first] = issues;
  if (!first) {
    return "unknown";
  }
  return first.path.length > 0 ? `${first.path.join(".")}: ${first.message}` : first.message;
}
