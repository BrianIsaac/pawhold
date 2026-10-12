import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { patientCase, practice, session, webhookEvent } from "@/db/schema";

import { connectTestDatabase } from "../support/database";

const { db } = connectTestDatabase();

/**
 * Reads the Postgres error code a failed statement carries, through the
 * driver's wrapping.
 *
 * @param promise - The statement expected to fail.
 * @returns The SQLSTATE code.
 */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? (error as { code?: string }).code;
  }
  return undefined;
}

describe("the schema as migrated", () => {
  it("holds the five tables U1 owns", async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name
    `);
    const names = rows.map((row) => row.table_name);

    expect(names).toEqual(
      expect.arrayContaining([
        "audit_event",
        "patient_case",
        "practice",
        "session",
        "webhook_event",
      ]),
    );
  });

  it("starts a case as an estimate draft in pounds, inside its practice", async () => {
    const [created] = await db
      .insert(practice)
      .values({ name: "Test practice", kind: "judge" })
      .returning();
    const [kase] = await db
      .insert(patientCase)
      .values({
        practiceId: created!.id,
        patientName: "Biscuit",
        ownerName: "A. Owner",
        procedure: "Dental under general anaesthetic",
      })
      .returning();

    expect(kase!.moneyState).toBe("estimate_draft");
    expect(kase!.currencyCode).toBe("GBP");
  });

  it("refuses a currency outside the plan's two", async () => {
    const [created] = await db
      .insert(practice)
      .values({ name: "Test practice", kind: "judge" })
      .returning();

    const code = await sqlState(
      db.insert(patientCase).values({
        practiceId: created!.id,
        patientName: "Biscuit",
        ownerName: "A. Owner",
        procedure: "Spay",
        currencyCode: "SGD",
      }),
    );

    expect(code).toBe("23514");
  });

  it("refuses a session that expires before it starts", async () => {
    const [created] = await db
      .insert(practice)
      .values({ name: "Test practice", kind: "judge" })
      .returning();
    const now = new Date();

    const code = await sqlState(
      db.insert(session).values({
        practiceId: created!.id,
        door: "practice",
        createdAt: now,
        expiresAt: new Date(now.getTime() - 1000),
      }),
    );

    expect(code).toBe("23514");
  });

  it("keys a webhook event by PayPal's event id", async () => {
    const eventId = `WH-TEST-${randomUUID()}`;
    const row = {
      eventId,
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      transmissionId: randomUUID(),
      transmissionTime: "2026-10-12T00:00:00Z",
      authAlgo: "SHA256withRSA",
      verification: "signature" as const,
      rawBody: "{}",
      payload: {},
    };
    await db.insert(webhookEvent).values(row);

    expect(await sqlState(db.insert(webhookEvent).values(row))).toBe("23505");
  });
});
