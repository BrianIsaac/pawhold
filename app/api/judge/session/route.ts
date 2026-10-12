import { judgeSessionHandlers } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Starts a judge's session through one of the landing page's doors (plan 7.4).
 *
 * @param request - `{ "door": "practice" | "owner" }`.
 * @returns 201 with the new practice and a signed session cookie.
 */
export async function POST(request: Request): Promise<Response> {
  return judgeSessionHandlers().POST(request);
}

/**
 * The current judge session.
 *
 * @param request - The request with its session cookie.
 * @returns 200 with the session, or 401.
 */
export async function GET(request: Request): Promise<Response> {
  return judgeSessionHandlers().GET(request);
}
