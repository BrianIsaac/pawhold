import { currentPracticeSession } from "@/server/practice-session";

import { type EncodedModule, pickEncoding, schedulerModule } from "./module";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether a request already holds the module by its tag: `If-None-Match`
 * may list several tags, and marks a weak one with `W/`.
 *
 * @param ifNoneMatch - The request's `If-None-Match`, or null.
 * @param tag - The module's entity tag.
 * @returns Whether the browser has it.
 */
function holdsTag(ifNoneMatch: string | null, tag: string): boolean {
  return (ifNoneMatch ?? "")
    .split(",")
    .map((held) => held.trim().replace(/^W\//, ""))
    .some((held) => held === tag || held === "*");
}

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
  // Kept by the browser, and asked after each time: an install's module is never used past its install.
  const headers: Record<string, string> = {
    "cache-control": "private, no-cache",
    etag: found.tag,
    vary: "Accept-Encoding",
  };
  if (holdsTag(request.headers.get("if-none-match"), found.tag)) {
    return new Response(null, { status: 304, headers });
  }
  if (encoding !== "identity") {
    headers["content-encoding"] = encoding;
  }
  return new Response(new Uint8Array(found.body), {
    headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
  });
}
