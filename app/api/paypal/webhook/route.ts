import { webhookHandler } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PayPal's webhook listener (plan 3.1, U1): verify, store by event id,
 * answer 200 only after the store.
 *
 * @param request - PayPal's delivery.
 * @returns The listener's answer.
 */
export async function POST(request: Request): Promise<Response> {
  return webhookHandler()(request);
}
