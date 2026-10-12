import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";

/** What the health check needs. */
export interface HealthDependencies {
  /** The database; may throw when none is configured. */
  readonly database: () => Database;
  /** How long to wait for the database. */
  readonly timeoutMs?: number;
  /** The deployed commit (Render sets `RENDER_GIT_COMMIT`). */
  readonly commit?: string | null;
}

/**
 * Builds `GET /api/health`: 200 when the database answers a query, 503
 * otherwise, so Render's health check and the uptime check see the state
 * that matters.
 *
 * @param dependencies - The database and the limits.
 * @returns The handler.
 */
export function createHealthHandler(dependencies: HealthDependencies): () => Promise<Response> {
  const timeoutMs = dependencies.timeoutMs ?? 3_000;
  const commit = dependencies.commit ?? null;

  return async () => {
    let database: Database;
    try {
      database = dependencies.database();
    } catch {
      return answer(503, { status: "unavailable", database: "unconfigured", commit });
    }
    try {
      await withTimeout(database.db.execute(sql`select 1`), timeoutMs);
      return answer(200, { status: "ok", database: "reached", commit });
    } catch {
      return answer(503, { status: "unavailable", database: "unreachable", commit });
    }
  };
}

/**
 * Rejects when a promise takes longer than the limit.
 *
 * @param promise - The work.
 * @param ms - The limit.
 * @returns The work's result.
 */
async function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A JSON answer that is never cached.
 *
 * @param status - The HTTP status.
 * @param body - The body.
 * @returns The response.
 */
function answer(status: number, body: Record<string, string | null>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
