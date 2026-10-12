import { healthHandler } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The health check Render and the uptime check call.
 *
 * @returns 200 with the database reached, or 503.
 */
export async function GET(): Promise<Response> {
  return healthHandler()();
}
