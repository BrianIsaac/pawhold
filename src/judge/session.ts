import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent } from "@/audit/writer";
import type { Database, Transaction } from "@/db/client";
import { practice, session, sessionDoor } from "@/db/schema";

/** The cookie a judge's session rides in. */
export const SESSION_COOKIE = "pawhold_session";

/** A judge's session lasts a week; the clean-up job prunes after that (plan 7.4). */
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The name a judge's practice carries until U2's seed names it. The working
 * name of D2 is not used until it is checked against Companies House and the
 * RCVS register.
 */
export const JUDGE_PRACTICE_NAME = "pawhold demo practice";

const SIGNATURE_DOMAIN = "pawhold.session.v1";

/**
 * Fills a new judge practice with its price list and cases. U2 supplies the
 * content; U1 calls it inside the transaction that makes the practice.
 */
export type PracticeSeed = (tx: Transaction, practiceId: string) => Promise<void>;

/** The seed until U2's lands: an empty practice. */
export const seedNothing: PracticeSeed = async () => {};

const startRequest = z.strictObject({ door: z.enum(sessionDoor.enumValues) });

/**
 * Signs a session id for its cookie: the id, a dot, and an HMAC-SHA256 of it
 * under the session secret, base64url.
 *
 * @param id - The session's id.
 * @param secret - The session secret.
 * @returns The cookie value.
 */
export function signSessionId(id: string, secret: string): string {
  return `${id}.${mac(id, secret).toString("base64url")}`;
}

/**
 * Reads a session cookie's value, checking its signature in constant time.
 *
 * @param value - The cookie value.
 * @param secret - The session secret.
 * @returns The session id, or null when the value is not one this server signed.
 */
export function readSessionCookie(value: string, secret: string): string | null {
  const dot = value.indexOf(".");
  if (dot < 0) {
    return null;
  }
  const id = value.slice(0, dot);
  if (!z.uuid().safeParse(id).success) {
    return null;
  }
  const given = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = mac(id, secret);
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

/**
 * The HMAC of a session id.
 *
 * @param id - The session's id.
 * @param secret - The session secret.
 * @returns The MAC.
 */
function mac(id: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${SIGNATURE_DOMAIN}|${id}`).digest();
}

/** What the session endpoints need. */
export interface JudgeSessionDependencies {
  readonly db: Database["db"];
  readonly secret: string;
  readonly seed?: PracticeSeed;
  /** The clock, in milliseconds since the epoch. */
  readonly now?: () => number;
  /** Mark the cookie Secure; on in production. */
  readonly secureCookie?: boolean;
}

/** A judge's session and its practice. */
export interface JudgeSession {
  readonly sessionId: string;
  readonly practiceId: string;
  readonly practiceName: string;
  readonly door: (typeof sessionDoor.enumValues)[number];
  readonly expiresAt: Date;
}

/**
 * Finds the live judge session a request's cookie names.
 *
 * @param db - The database.
 * @param request - The request.
 * @param secret - The session secret.
 * @param now - The current time.
 * @returns The session, or null when there is none or it has expired.
 */
export async function findJudgeSession(
  db: Database["db"],
  request: Request,
  secret: string,
  now: Date,
): Promise<JudgeSession | null> {
  const value = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const id = value === null ? null : readSessionCookie(value, secret);
  if (id === null) {
    return null;
  }
  const [found] = await db
    .select({
      sessionId: session.id,
      practiceId: practice.id,
      practiceName: practice.name,
      door: session.door,
      expiresAt: session.expiresAt,
    })
    .from(session)
    .innerJoin(practice, eq(practice.id, session.practiceId))
    .where(and(eq(session.id, id), gt(session.expiresAt, now)));
  return found ?? null;
}

/**
 * Builds `POST /api/judge/session` (start a session through one of the
 * landing page's two doors: a new practice, seeded, and a signed cookie; no
 * account) and `GET /api/judge/session` (the current session).
 *
 * @param dependencies - The database, the secret, the seed and the clock.
 * @returns The two handlers.
 */
export function createJudgeSessionHandlers(dependencies: JudgeSessionDependencies): {
  POST: (request: Request) => Promise<Response>;
  GET: (request: Request) => Promise<Response>;
} {
  const now = dependencies.now ?? Date.now;
  const seed = dependencies.seed ?? seedNothing;

  return {
    POST: async (request) => {
      if (!sameOrigin(request)) {
        return answer(403, { error: "cross_origin" });
      }
      let door: JudgeSession["door"];
      try {
        door = startRequest.parse(await request.json()).door;
      } catch {
        return answer(400, { error: "door_invalid" });
      }

      const createdAt = new Date(now());
      const expiresAt = new Date(createdAt.getTime() + SESSION_LIFETIME_MS);
      const started = await dependencies.db.transaction(async (tx) => {
        const [made] = await tx
          .insert(practice)
          .values({ name: JUDGE_PRACTICE_NAME, kind: "judge", createdAt })
          .returning({ id: practice.id });
        const practiceId = made!.id;
        await seed(tx, practiceId);
        const [opened] = await tx
          .insert(session)
          .values({ practiceId, door, createdAt, expiresAt, lastSeenAt: createdAt })
          .returning({ id: session.id });
        await appendAuditEvent(tx, {
          practiceId,
          actor: "system",
          action: "judge.session.started",
          detail: { door },
        });
        return { sessionId: opened!.id, practiceId };
      });

      const cookie = [
        `${SESSION_COOKIE}=${signSessionId(started.sessionId, dependencies.secret)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${SESSION_LIFETIME_MS / 1000}`,
        ...((dependencies.secureCookie ?? false) ? ["Secure"] : []),
      ].join("; ");
      return answer(
        201,
        { practiceId: started.practiceId, door, expiresAt: expiresAt.toISOString() },
        { "set-cookie": cookie },
      );
    },

    GET: async (request) => {
      const found = await findJudgeSession(
        dependencies.db,
        request,
        dependencies.secret,
        new Date(now()),
      );
      if (!found) {
        return answer(401, { error: "no_session" });
      }
      return answer(200, {
        practiceId: found.practiceId,
        practiceName: found.practiceName,
        door: found.door,
        expiresAt: found.expiresAt.toISOString(),
      });
    },
  };
}

/**
 * Whether a request's Origin, when it sends one, is the server's own. A
 * session started from another site would sign the visitor into a practice
 * of that site's choosing.
 *
 * @param request - The request.
 * @returns True when there is no Origin or it matches the request's host.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return true;
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === (host ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

/**
 * Reads one cookie from a Cookie header.
 *
 * @param header - The Cookie header.
 * @param name - The cookie's name.
 * @returns Its value, or null.
 */
function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return rest.join("=");
    }
  }
  return null;
}

/**
 * A JSON answer that is never cached.
 *
 * @param status - The HTTP status.
 * @param body - The body.
 * @param headers - More headers.
 * @returns The response.
 */
function answer(
  status: number,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}
