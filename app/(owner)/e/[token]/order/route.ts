import { ownerHandlers } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The hold's PayPal order for the JS SDK's `createOrder`.
 *
 * @param request - The request.
 * @param context - The route's parameters.
 * @param context.params - The link's token.
 * @returns The answer.
 */
export async function POST(
  request: Request,
  { params }: RouteContext<"/e/[token]/order">,
): Promise<Response> {
  const { token } = await params;
  return ownerHandlers().order(request, token);
}
