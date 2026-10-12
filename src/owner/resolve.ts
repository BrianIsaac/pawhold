import { and, eq, isNotNull } from "drizzle-orm";

import type { Executor } from "@/db/client";
import { estimateVersion, patientCase, practice } from "@/db/schema";

import { judgePracticeEnded } from "@/judge/cleanup";

import { verifyOwnerToken } from "./link";

/** What an owner's link opens. */
export type ResolvedOwnerLink =
  | {
      readonly kind: "open";
      readonly practiceId: string;
      readonly practiceName: string;
      readonly caseId: string;
      readonly versionId: string;
      readonly expiresAt: Date;
    }
  | {
      readonly kind: "ask_the_practice";
      /** The practice to ask, when the link's signature holds and names a case it has. */
      readonly practiceName: string | null;
    };

/**
 * Resolves an owner's link to the case and the sent version it opens, or to
 * the "ask the practice" page: an expired link, or one to a judge's practice
 * the clean-up has ended (U9), names its practice; a changed
 * one, or one naming a case or a sent version the store does not hold, names
 * none.
 *
 * @param executor - The pool or an open transaction.
 * @param token - The token from the link's path.
 * @param signing - The server's secret and the time now.
 * @param signing.secret - The server's secret (`SESSION_SECRET`).
 * @param signing.now - The time to check the expiry against.
 * @returns What the link opens.
 */
export async function resolveOwnerLink(
  executor: Executor,
  token: string,
  signing: { readonly secret: string; readonly now: Date },
): Promise<ResolvedOwnerLink> {
  const check = verifyOwnerToken(token, signing.secret, signing.now);
  if (check.status === "invalid") {
    return { kind: "ask_the_practice", practiceName: null };
  }
  const [found] = await executor
    .select({ practiceId: practice.id, practiceName: practice.name })
    .from(estimateVersion)
    .innerJoin(
      patientCase,
      and(
        eq(patientCase.id, estimateVersion.caseId),
        eq(patientCase.practiceId, estimateVersion.practiceId),
      ),
    )
    .innerJoin(practice, eq(practice.id, patientCase.practiceId))
    .where(
      and(
        eq(estimateVersion.id, check.versionId),
        eq(estimateVersion.caseId, check.caseId),
        isNotNull(estimateVersion.sentAt),
      ),
    );
  if (!found) {
    return { kind: "ask_the_practice", practiceName: null };
  }
  if (
    check.status === "expired" ||
    (await judgePracticeEnded(executor, found.practiceId, signing.now))
  ) {
    return { kind: "ask_the_practice", practiceName: found.practiceName };
  }
  return {
    kind: "open",
    practiceId: found.practiceId,
    practiceName: found.practiceName,
    caseId: check.caseId,
    versionId: check.versionId,
    expiresAt: check.expiresAt,
  };
}
