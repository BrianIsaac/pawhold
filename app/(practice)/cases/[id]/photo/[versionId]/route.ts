import { z } from "zod";

import { loadSourcePhoto } from "@/practice/update";
import { currentPracticeSession } from "@/server/practice-session";
import { database } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An update's photo, for the practice signed in: never cached, never
 * sniffed into another type.
 *
 * @param _request - The request.
 * @param context - The route's parameters.
 * @param context.params - The case and the version.
 * @returns The photo, or 404.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
): Promise<Response> {
  const { id, versionId } = await context.params;
  const session = await currentPracticeSession();
  if (!session || !z.uuid().safeParse(id).success || !z.uuid().safeParse(versionId).success) {
    return new Response("Not found", { status: 404 });
  }
  const photo = await loadSourcePhoto(database().db, {
    practiceId: session.practiceId,
    caseId: id,
    versionId,
  });
  if (!photo) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(new Uint8Array(photo.bytes), {
    headers: {
      "content-type": photo.mediaType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}
