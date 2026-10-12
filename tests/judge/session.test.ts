import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { auditEvent, practice } from "@/db/schema";
import {
  createJudgeSessionHandlers,
  findJudgeSessionByCookie,
  readSessionCookie,
  SESSION_COOKIE,
  signSessionId,
} from "@/judge/session";

import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();
const SECRET = "test-session-secret-0123456789abcdef-not-real";
const ORIGIN = "https://pawhold.test";

/**
 * A request to the judge session endpoint.
 *
 * @param method - GET or POST.
 * @param init - The body, the cookie and the origin.
 * @param init.body - A JSON body.
 * @param init.cookie - The Cookie header.
 * @param init.origin - The Origin header.
 * @returns The request.
 */
function request(
  method: "GET" | "POST",
  init: { body?: unknown; cookie?: string; origin?: string } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.origin) headers.set("origin", init.origin);
  return new Request(`${ORIGIN}/api/judge/session`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/**
 * The `name=value` pair of the session cookie a response sets.
 *
 * @param response - The response.
 * @returns The cookie pair for a Cookie header.
 */
function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0]!;
}

describe("judge-mode sessions (plan 7.4)", () => {
  it("gives a visitor their own seeded practice and a signed cookie, no account needed", async () => {
    const seed = vi.fn(async () => {});
    const handlers = createJudgeSessionHandlers({ db, secret: SECRET, seed });

    const started = await handlers.POST(
      request("POST", { body: { door: "practice" }, origin: ORIGIN }),
    );

    expect(started.status).toBe(201);
    const body = (await started.json()) as { practiceId: string; door: string; expiresAt: string };
    expect(body.door).toBe("practice");
    expect(seed).toHaveBeenCalledWith(expect.anything(), body.practiceId, expect.any(Date));
    const [created] = await db.select().from(practice).where(eq(practice.id, body.practiceId));
    expect(created!.kind).toBe("judge");
    const setCookie = started.headers.get("set-cookie")!;
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=604800/);
    const audit = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.practiceId, body.practiceId));
    expect(audit.map((event) => event.action)).toEqual(["judge.session.started"]);

    const current = await handlers.GET(request("GET", { cookie: cookieFrom(started) }));
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ practiceId: body.practiceId, door: "practice" });
  });

  it("never lets two visitors share a practice", async () => {
    const handlers = createJudgeSessionHandlers({ db, secret: SECRET });

    const first = await handlers.POST(request("POST", { body: { door: "owner" } }));
    const second = await handlers.POST(request("POST", { body: { door: "owner" } }));

    const ids = [first, second].map(
      async (r) => ((await r.json()) as { practiceId: string }).practiceId,
    );
    const [a, b] = await Promise.all(ids);
    expect(a).not.toBe(b);
  });

  it("refuses a cookie whose signature was altered, or signed with another secret", async () => {
    const handlers = createJudgeSessionHandlers({ db, secret: SECRET });
    const started = await handlers.POST(request("POST", { body: { door: "practice" } }));
    const [name, value] = cookieFrom(started).split("=") as [string, string];
    const [id] = value.split(".") as [string];

    const altered = `${name}=${value.slice(0, -2)}${value.endsWith("A") ? "BB" : "AA"}`;
    const foreign = `${name}=${signSessionId(id, "another-secret-0123456789abcdef-not-real")}`;

    expect((await handlers.GET(request("GET", { cookie: altered }))).status).toBe(401);
    expect((await handlers.GET(request("GET", { cookie: foreign }))).status).toBe(401);
    expect((await handlers.GET(request("GET"))).status).toBe(401);
  });

  it("refuses a session past its expiry", async () => {
    let now = Date.UTC(2026, 9, 12);
    const handlers = createJudgeSessionHandlers({ db, secret: SECRET, now: () => now });
    const started = await handlers.POST(request("POST", { body: { door: "practice" } }));

    now += 7 * 24 * 60 * 60 * 1000 + 1;

    expect((await handlers.GET(request("GET", { cookie: cookieFrom(started) }))).status).toBe(401);
  });

  it("refuses a door the landing page does not offer", async () => {
    const handlers = createJudgeSessionHandlers({ db, secret: SECRET });

    const answer = await handlers.POST(request("POST", { body: { door: "admin" } }));

    expect(answer.status).toBe(400);
  });

  it("refuses a session started from another site", async () => {
    // Every session is made with its practice, seeded in the same transaction:
    // a seed never called means no practice and no session was made. (A count
    // of the whole table raced the files that make sessions beside this one.)
    const seed = vi.fn(async () => {});
    const handlers = createJudgeSessionHandlers({ db, secret: SECRET, seed });

    const answer = await handlers.POST(
      request("POST", { body: { door: "practice" }, origin: "https://attacker.example" }),
    );

    expect(answer.status).toBe(403);
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(seed).not.toHaveBeenCalled();

    const sameSite = await handlers.POST(
      request("POST", { body: { door: "practice" }, origin: ORIGIN }),
    );
    expect(sameSite.status).toBe(201);
    expect(seed).toHaveBeenCalledTimes(1);
  });
});

describe("a session read from its cookie's value (the practice's screens)", () => {
  it("finds the live session and its practice, and nothing for a forged, missing or expired one", async () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    const handlers = createJudgeSessionHandlers({ db, secret: SECRET, now: () => now });
    const started = await handlers.POST(request("POST", { body: { door: "practice" } }));
    const value = started.headers
      .get("set-cookie")!
      .split(";")[0]!
      .slice(SESSION_COOKIE.length + 1);
    const { practiceId } = (await started.json()) as { practiceId: string };

    const found = await findJudgeSessionByCookie(db, value, SECRET, new Date(now));
    expect(found).toMatchObject({ practiceId, door: "practice" });
    expect(await findJudgeSessionByCookie(db, null, SECRET, new Date(now))).toBeNull();
    expect(await findJudgeSessionByCookie(db, `${value}x`, SECRET, new Date(now))).toBeNull();
    expect(
      await findJudgeSessionByCookie(db, value, SECRET, new Date(now + 8 * 24 * 60 * 60 * 1000)),
    ).toBeNull();
  });
});

describe("the session cookie's signature", () => {
  it("round-trips an id and refuses anything else", () => {
    const id = "6f1c1f55-8f39-4d5e-9d39-2b0c0e7a3a10";
    const signed = signSessionId(id, SECRET);

    expect(readSessionCookie(signed, SECRET)).toBe(id);
    expect(readSessionCookie(`${id}.`, SECRET)).toBeNull();
    expect(readSessionCookie("not-a-cookie", SECRET)).toBeNull();
    expect(
      readSessionCookie(signed.replace(id, "0c8f6f2e-4f5a-4b8e-9f1e-3d2a1b0c9e8d"), SECRET),
    ).toBeNull();
  });
});
