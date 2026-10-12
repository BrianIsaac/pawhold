import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { patientCase, session } from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { createJudgeDoors } from "@/judge/doors";
import { SESSION_COOKIE, signSessionId } from "@/judge/session";
import { verifyOwnerToken } from "@/owner/link";

import { seedFictionalPractice } from "../../seed/practice";
import { OWNER_DOOR_CASE } from "../../seed/showcase/cases";
import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();
const SECRET = "test-session-secret-0123456789abcdef-not-real";
const ORIGIN = "https://pawhold.test";

/** The practices this file's doors seeded, in order: other files share the database. */
const seeded: string[] = [];
const doors = createJudgeDoors({
  db,
  secret: SECRET,
  seed: async (tx, practiceId) => {
    seeded.push(practiceId);
    await seedFictionalPractice(tx, practiceId);
  },
});

/**
 * A click on one of the landing page's doors: a plain link, so a GET with
 * the browser's fetch metadata.
 *
 * @param door - The door's path segment.
 * @param init - The Cookie header and where the click came from.
 * @param init.cookie - The Cookie header.
 * @param init.site - The Sec-Fetch-Site header.
 * @returns The response.
 */
function click(
  door: string,
  init: { cookie?: string; site?: "same-origin" | "same-site" | "cross-site" | "none" } = {},
): Promise<Response> {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  headers.set("sec-fetch-site", init.site ?? "same-origin");
  return doors.GET(new Request(`${ORIGIN}/try/${door}`, { headers }), door);
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

/**
 * How many practices this file's doors have seeded.
 *
 * @returns The count.
 */
function practices(): number {
  return seeded.length;
}

describe("the landing page's doors (section 6, plan 7.4)", () => {
  it("'Try it as the practice' starts a session with a seeded practice of its own and lands on today's cases", async () => {
    const before = practices();
    const response = await click("practice");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/today");
    expect(response.headers.get("set-cookie")).toMatch(
      new RegExp(
        `^${SESSION_COOKIE}=[0-9a-f-]{36}\\.[A-Za-z0-9_-]+; Path=/; HttpOnly; SameSite=Lax`,
      ),
    );
    expect(practices()).toBe(before + 1);
    const [opened] = await db
      .select({ door: session.door, practiceId: session.practiceId })
      .from(session)
      .where(eq(session.id, cookieFrom(response).split("=")[1]!.split(".")[0]!));
    expect(opened?.door).toBe("practice");
    const cases = await db
      .select({ id: patientCase.id })
      .from(patientCase)
      .where(eq(patientCase.practiceId, opened!.practiceId));
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  it("'Try it as the owner' lands on the owner's link to the showcase case awaiting its owner", async () => {
    const response = await click("owner");

    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/e\/[A-Za-z0-9_-]{92}$/);
    const check = verifyOwnerToken(location.slice(3), SECRET, new Date());
    expect(check.status).toBe("valid");
    const [kase] = await db
      .select()
      .from(patientCase)
      .where(eq(patientCase.id, check.status === "valid" ? check.caseId : ""));
    expect(kase).toMatchObject({
      patientName: OWNER_DOOR_CASE.patientName,
      moneyState: "awaiting_owner",
    });
    const versions = await caseEstimateVersions(db, kase!.practiceId, kase!.id);
    expect(check.status === "valid" && check.versionId).toBe(versions.at(-1)!.id);
  });

  it("is idempotent: a door clicked again with the session's cookie seeds nothing and keeps the session", async () => {
    const first = await click("practice");
    const cookie = cookieFrom(first);
    const before = practices();

    const again = await click("owner", { cookie });
    const back = await click("practice", { cookie });

    expect(practices()).toBe(before);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(back.headers.get("set-cookie")).toBeNull();
    expect(again.headers.get("location")).toMatch(/^\/e\//);
    expect(back.headers.get("location")).toBe("/today");
  });

  it("starts a new session when the cookie is not one this server signed, or its session has ended", async () => {
    const forged = `${SESSION_COOKIE}=${signSessionId(crypto.randomUUID(), "another-secret-0123456789abcdef-xx")}`;
    const before = practices();

    const response = await click("practice", { cookie: forged });

    expect(response.headers.get("set-cookie")).not.toBeNull();
    expect(practices()).toBe(before + 1);
  });

  it("starts no session from another site's link: it shows the landing page instead", async () => {
    const before = practices();

    const response = await click("practice", { site: "cross-site" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(practices()).toBe(before);
  });

  it("opens from the address bar (no site) and from a same-site page", async () => {
    expect((await click("practice", { site: "none" })).headers.get("location")).toBe("/today");
    expect((await click("practice", { site: "same-site" })).headers.get("location")).toBe("/today");
  });

  it("answers 404 for a door that is not one of the two", async () => {
    const before = practices();

    const response = await click("vet");

    expect(response.status).toBe(404);
    expect(practices()).toBe(before);
  });

  it("is never cached and never indexed", async () => {
    const response = await click("practice");

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
