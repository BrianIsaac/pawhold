import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client";
import { auditEvent, sessionDoor } from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { ownerLink } from "@/owner/link";

import {
  findJudgeSession,
  type JudgeSessionDependencies,
  sessionCookie,
  startJudgeSession,
} from "./session";

/** Where each door lands when its practice has no case for the owner's door. */
const PRACTICE_LANDING = "/today";

const door = z.enum(sessionDoor.enumValues);

/** The part of `practice.seeded` the owner's door reads: the case it opens. */
const seededPractice = z.looseObject({ ownerDoorCaseId: z.uuid() });

/**
 * Builds the landing page's two doors, `GET /try/practice` and `GET
 * /try/owner` (section 6, plan 7.4). Each is a plain link, so it works
 * without JavaScript: the first click starts a session, its practice seeded
 * in the transaction that makes it, and sets U1's cookie; a click with a
 * live session's cookie keeps that session and seeds nothing. "Try it as the
 * practice" lands on today's cases; "Try it as the owner" lands on the
 * owner's link (U6's `ownerLink`) to the showcase case awaiting its owner. A
 * link followed from another site starts no session and shows the landing
 * page, so no other site can start sessions in a visitor's browser.
 *
 * @param dependencies - The database, the secret, the seed, the clock and whether cookies are Secure.
 * @returns The handler, given the request and the door's path segment.
 */
export function createJudgeDoors(dependencies: JudgeSessionDependencies): {
  GET: (request: Request, segment: string) => Promise<Response>;
} {
  const now = dependencies.now ?? Date.now;
  return {
    GET: async (request, segment) => {
      const parsed = door.safeParse(segment);
      if (!parsed.success) {
        return new Response("Not found", { status: 404, headers: HEADERS });
      }
      if (request.headers.get("sec-fetch-site") === "cross-site") {
        return landOn("/");
      }
      const at = new Date(now());
      const live = await findJudgeSession(dependencies.db, request, dependencies.secret, at);
      const started = live ? null : await startJudgeSession(dependencies, parsed.data);
      const practiceId = live?.practiceId ?? started!.practiceId;
      const location =
        parsed.data === "owner"
          ? ((await ownerDoorPath(dependencies.db, practiceId, dependencies.secret, at)) ??
            PRACTICE_LANDING)
          : PRACTICE_LANDING;
      return landOn(
        location,
        started
          ? sessionCookie(
              started.sessionId,
              dependencies.secret,
              dependencies.secureCookie ?? false,
            )
          : null,
      );
    },
  };
}

/** Every door's answer: never cached, never indexed. */
const HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } as const;

/**
 * A 303 to where the door lands, with the new session's cookie when it made one.
 *
 * @param location - The path.
 * @param cookie - The Set-Cookie value, or null.
 * @returns The response.
 */
function landOn(location: string, cookie: string | null = null): Response {
  return new Response(null, {
    status: 303,
    headers: { ...HEADERS, location, ...(cookie ? { "set-cookie": cookie } : {}) },
  });
}

/**
 * The owner's link to the case the owner's door opens: the one the seed
 * named in `practice.seeded`, at its latest sent estimate, minted now.
 *
 * @param db - The database.
 * @param practiceId - The session's practice.
 * @param secret - The secret links are signed with.
 * @param now - The clock.
 * @returns The link's path, or null when the practice was seeded with no such case.
 */
export async function ownerDoorPath(
  db: Database["db"],
  practiceId: string,
  secret: string,
  now: Date,
): Promise<string | null> {
  const [seeded] = await db
    .select({ detail: auditEvent.detail })
    .from(auditEvent)
    .where(and(eq(auditEvent.practiceId, practiceId), eq(auditEvent.action, "practice.seeded")))
    .orderBy(asc(auditEvent.id))
    .limit(1);
  const named = seededPractice.safeParse(seeded?.detail);
  if (!named.success) {
    return null;
  }
  const caseId = named.data.ownerDoorCaseId;
  const sent = (await caseEstimateVersions(db, practiceId, caseId)).filter(
    (version) => version.sentAt !== null,
  );
  const latest = sent.at(-1);
  if (!latest) {
    return null;
  }
  const link = await ownerLink(db, { practiceId, caseId, versionId: latest.id }, { secret, now });
  return link.path;
}
