import { ownerHandlers } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The case's money state and the link's hold, which the page polls for PayPal's confirmation.
 *
 * @param request - The request.
 * @param context - The route's parameters.
 * @param context.params - The link's token.
 * @returns The answer.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/e/[token]/status">,
): Promise<Response> {
  const { token } = await params;
  return ownerHandlers().status(request, token);
}
