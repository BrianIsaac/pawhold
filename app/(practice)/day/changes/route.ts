import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

import { dayStamp } from "../stamp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Never kept by a cache: the open day asks after it every few seconds. */
const NO_STORE = { "cache-control": "private, no-store" };

/**
 * The signed-in practice's day stamp (`dayStamp`), which the open day polls
 * to learn that a case's money or the schedule has changed (U8b).
 *
 * @returns The stamp as JSON; 401 signed out.
 */
export async function GET(): Promise<Response> {
  const session = await currentPracticeSession();
  if (!session) {
    return Response.json({ error: "signed_out" }, { status: 401, headers: NO_STORE });
  }
  return Response.json(
    { stamp: await dayStamp(database().db, session.practiceId) },
    { headers: NO_STORE },
  );
}
