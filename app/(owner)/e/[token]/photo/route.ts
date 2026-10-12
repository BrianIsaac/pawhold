import { ownerHandlers } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The photo the vet shared with the owner on the update the link names (U11).
 *
 * @param request - The request.
 * @param context - The route's parameters.
 * @param context.params - The link's token.
 * @returns The photo, or 404.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/e/[token]/photo">,
): Promise<Response> {
  const { token } = await params;
  return ownerHandlers().photo(request, token);
}
