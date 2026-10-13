import { currentPracticeSession } from "@/server/practice-session";

import { type EncodedModule, pickEncoding, schedulerModule } from "./module";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Scheduler's own module, for the day's board (U8b): served from the
 * installed package as its maker ships it, never through this
 * application's bundler (which cannot take the trial's obfuscated bundle)
 * and never from a copy in this repository. The browser imports it by this
 * address (`scheduler-core.ts`). Only a signed-in practice is answered; a
 * package that is not installed is a 404, which the day meets by staying on
 * the plain timeline.
 *
 * @param request - The request, for what it accepts and the tag it holds.
 * @returns The module, 304 when the browser has it, 401 without a session, 404 when the package is absent.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await currentPracticeSession())) {
    return new Response(null, { status: 401, headers: { "cache-control": "private, no-store" } });
  }
  const encoding = pickEncoding(request.headers.get("accept-encoding"));
  let found: EncodedModule;
  try {
    found = await schedulerModule(encoding);
  } catch {
    return new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } });
  }
  const headers: Record<string, string> = {
    "cache-control": "private, max-age=3600",
    etag: found.tag,
    vary: "Accept-Encoding",
  };
  if (request.headers.get("if-none-match") === found.tag) {
    return new Response(null, { status: 304, headers });
  }
  if (encoding !== "identity") {
    headers["content-encoding"] = encoding;
  }
  return new Response(new Uint8Array(found.body), {
    headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
  });
}
