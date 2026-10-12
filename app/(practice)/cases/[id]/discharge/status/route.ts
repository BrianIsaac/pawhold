import { z } from "zod";

import { dischargeProgress, progressJson } from "@/discharge/progress";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Never kept by a cache: the page polls it for each step and PayPal's tick. */
const NO_STORE = { "cache-control": "private, no-store" };

/**
 * The case's discharge as it stands, which the discharge page polls to show
 * each hold's capture and release as they land and PayPal's confirmation of
 * each. The signed-in practice's own cases only.
 *
 * @param _request - The request.
 * @param context - The route's parameters.
 * @param context.params - The case's id.
 * @returns The progress as JSON; 401 signed out; 404 for no such case or no signed-off bill.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext<"/cases/[id]/discharge/status">,
): Promise<Response> {
  const session = await currentPracticeSession();
  if (!session) {
    return Response.json({ error: "signed_out" }, { status: 401, headers: NO_STORE });
  }
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }
  const progress = await dischargeProgress(database().db, session.practiceId, id);
  if (!progress) {
    return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }
  return Response.json(progressJson(progress), { headers: NO_STORE });
}
