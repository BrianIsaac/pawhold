import { ownerHandlers } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authorises the order the owner approved (`onApprove`, or the card fields' submit).
 *
 * @param request - The request.
 * @param context - The route's parameters.
 * @param context.params - The link's token.
 * @returns The answer.
 */
export async function POST(
  request: Request,
  { params }: RouteContext<"/e/[token]/authorise">,
): Promise<Response> {
  const { token } = await params;
  return ownerHandlers().authorise(request, token);
}
