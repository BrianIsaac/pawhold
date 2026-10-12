import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { AskFailure } from "@/agent/ask";
import type { UnmatchedSpan, UnsupportedLine } from "@/agent/guardrails";
import type { ModelFailure } from "@/agent/model";
import type { Executor } from "@/db/client";
import { estimateSource, PHOTO_MEDIA_TYPES } from "@/db/schema";

/** An update's photo, as a page shows it (its bytes are served on their own). */
export interface SourcePhoto {
  readonly mediaType: (typeof PHOTO_MEDIA_TYPES)[number];
  readonly sha256: string;
  readonly bytes: number;
  /** "Show the photo to the owner" (section 6). */
  readonly shared: boolean;
}

/** The words a version was drafted from and what the draft made of them. */
export interface SourceView {
  readonly versionId: string;
  readonly kind: "notes" | "finding";
  readonly text: string;
  readonly unmatched: readonly UnmatchedSpan[];
  readonly unsupported: readonly UnsupportedLine[];
  readonly failure: AskFailure | null;
  readonly explanation: string | null;
  readonly explanationFellBack: string | null;
  readonly photo: SourcePhoto | null;
}

const unmatchedSpan = z.object({
  notesSpan: z.string(),
  start: z.int(),
  end: z.int(),
  code: z.string().nullable(),
});

const unsupportedLine = z.object({
  reason: z.enum(["span_not_in_notes", "invalid_line", "too_many_lines"]),
  code: z.string().nullable(),
  notesSpan: z.string().nullable(),
  message: z.string(),
});

/** U4's model failures, every one: a `Record` holds the list to `ModelFailure` both ways. */
const MODEL_FAILURES: Record<ModelFailure, true> = {
  unavailable: true,
  not_recorded: true,
  refused: true,
  truncated: true,
  malformed: true,
  provider: true,
  transport: true,
  capped: true,
};

const askFailure = z.object({
  reason: z.enum(Object.keys(MODEL_FAILURES) as [ModelFailure, ...ModelFailure[]]),
  message: z.string(),
});

/**
 * A case's sources by version, without the photos' bytes.
 *
 * @param executor - The pool or an open transaction.
 * @param caseId - The case.
 * @returns Each version's source.
 */
export async function caseSources(
  executor: Executor,
  caseId: string,
): Promise<Map<string, SourceView>> {
  const rows = await executor
    .select({
      versionId: estimateSource.versionId,
      kind: estimateSource.kind,
      text: estimateSource.text,
      unmatched: estimateSource.unmatched,
      unsupported: estimateSource.unsupported,
      failure: estimateSource.failure,
      explanation: estimateSource.explanation,
      explanationFellBack: estimateSource.explanationFellBack,
      photoMediaType: estimateSource.photoMediaType,
      photoSha256: estimateSource.photoSha256,
      photoBytes: sql<number | null>`octet_length(${estimateSource.photo})`,
      photoShared: estimateSource.photoShared,
    })
    .from(estimateSource)
    .where(eq(estimateSource.caseId, caseId));
  return new Map(
    rows.map((row) => [
      row.versionId,
      {
        versionId: row.versionId,
        kind: row.kind,
        text: row.text,
        unmatched: z.array(unmatchedSpan).parse(row.unmatched),
        unsupported: z.array(unsupportedLine).parse(row.unsupported),
        failure: row.failure === null ? null : askFailure.parse(row.failure),
        explanation: row.explanation,
        explanationFellBack: row.explanationFellBack,
        photo:
          row.photoMediaType === null || row.photoSha256 === null || row.photoBytes === null
            ? null
            : {
                mediaType: z.enum(PHOTO_MEDIA_TYPES).parse(row.photoMediaType),
                sha256: row.photoSha256,
                bytes: Number(row.photoBytes),
                shared: row.photoShared,
              },
      },
    ]),
  );
}

/** What a draft made of the vet's words, to keep beside its version. */
export interface DraftOutcome {
  readonly unmatched: readonly UnmatchedSpan[];
  readonly unsupported: readonly UnsupportedLine[];
  readonly failure: AskFailure | null;
  readonly explanation?: string | null;
  readonly explanationFellBack?: string | null;
}

/** An update's photo as it is kept. */
export interface PhotoToKeep {
  readonly mediaType: (typeof PHOTO_MEDIA_TYPES)[number];
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly shared: boolean;
}

/**
 * Keeps the words a draft was made from beside its version, and what the
 * draft made of them. A failed redraft leaves the version's lines as they
 * were (U4's decision 20), so the words they came from are kept too and only
 * the failure is recorded; any other draft replaces the words and outcome.
 *
 * @param executor - The pool or an open transaction.
 * @param write - The version, its practice and case, the words and the outcome.
 * @param write.versionId - The draft version.
 * @param write.practiceId - The practice.
 * @param write.caseId - The case.
 * @param write.kind - Notes or a finding.
 * @param write.text - The words.
 * @param write.outcome - What the draft made of them.
 * @param write.preservedLines - Whether the draft kept lines it already had (a failed redraft).
 * @param write.photo - An update's photo, or null.
 * @returns Resolves once kept.
 */
export async function keepSource(
  executor: Executor,
  write: {
    versionId: string;
    practiceId: string;
    caseId: string;
    kind: "notes" | "finding";
    text: string;
    outcome: DraftOutcome;
    preservedLines: boolean;
    photo?: PhotoToKeep | null;
  },
): Promise<void> {
  const failure = write.outcome.failure === null ? null : { ...write.outcome.failure };
  const [existing] = await executor
    .select({ versionId: estimateSource.versionId })
    .from(estimateSource)
    .where(eq(estimateSource.versionId, write.versionId));
  if (existing && write.preservedLines && failure !== null) {
    await executor
      .update(estimateSource)
      .set({ failure, updatedAt: sql`now()` })
      .where(eq(estimateSource.versionId, write.versionId));
    return;
  }
  const photo = write.photo ?? null;
  const values = {
    text: write.text,
    unmatched: write.outcome.unmatched.map((one) => ({ ...one })),
    unsupported: write.outcome.unsupported.map((one) => ({ ...one })),
    failure,
    explanation: write.outcome.explanation ?? null,
    explanationFellBack: write.outcome.explanationFellBack ?? null,
    photo: photo?.bytes ?? null,
    photoMediaType: photo?.mediaType ?? null,
    photoSha256: photo?.sha256 ?? null,
    photoShared: photo?.shared ?? false,
  };
  await executor
    .insert(estimateSource)
    .values({
      versionId: write.versionId,
      practiceId: write.practiceId,
      caseId: write.caseId,
      kind: write.kind,
      ...values,
    })
    .onConflictDoUpdate({
      target: estimateSource.versionId,
      set: { ...values, updatedAt: sql`now()` },
    });
}
