import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { findJudgeSessionByCookie, type JudgeSession, SESSION_COOKIE } from "@/judge/session";

import { database, sessionSecret } from "./runtime";

/**
 * The judge session the request's cookie names (U1's session, plan 7.4), read
 * once per request: the practice's screens are signed in as its practice.
 * Either door's session is the practice's: a judge who came in as the owner
 * sees the same practice from its side.
 *
 * @returns The session, or null when the request has none or it has expired.
 */
export const currentPracticeSession = cache(async (): Promise<JudgeSession | null> => {
  const store = await cookies();
  return findJudgeSessionByCookie(
    database().db,
    store.get(SESSION_COOKIE)?.value ?? null,
    sessionSecret(),
    new Date(),
  );
});
