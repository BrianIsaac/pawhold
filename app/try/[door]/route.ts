import { judgeDoors } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One of the landing page's doors (`/try/practice`, `/try/owner`): starts the
 * visitor's session on the first click and lands where the door goes.
 *
 * @param request - The request, with its session cookie when it has one.
 * @param context - The route's parameters.
 * @param context.params - The door.
 * @returns A 303 to today's cases or the owner's page.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ door: string }> },
): Promise<Response> {
  const { door } = await context.params;
  return judgeDoors().GET(request, door);
}

/**
 * A HEAD to a door, as a link preview sends: answered without starting a
 * session (Next would otherwise answer it by running GET).
 *
 * @param request - The request.
 * @param context - The route's parameters.
 * @param context.params - The door.
 * @returns 200, or 404 for a door that is not one of the two.
 */
export async function HEAD(
  request: Request,
  context: { params: Promise<{ door: string }> },
): Promise<Response> {
  const { door } = await context.params;
  return judgeDoors().HEAD(request, door);
}
