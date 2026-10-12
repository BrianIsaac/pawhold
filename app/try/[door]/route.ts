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
