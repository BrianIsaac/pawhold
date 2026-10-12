import { ownerHandlers } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The owner's "Don't go ahead" on the update the link names.
 *
 * @param request - The request.
 * @param context - The route's parameters.
 * @param context.params - The link's token.
 * @returns The answer.
 */
export async function POST(
  request: Request,
  { params }: RouteContext<"/e/[token]/decline">,
): Promise<Response> {
  const { token } = await params;
  return ownerHandlers().decline(request, token);
}
