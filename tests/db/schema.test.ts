import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { patientCase, practice, session, webhookEvent } from "@/db/schema";

import { connectTestDatabase } from "../support/database";
import { refusalOf } from "../support/postgres-error";

const { db } = connectTestDatabase();

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

    const { code } = await refusalOf(
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

    const { code } = await refusalOf(
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

    expect((await refusalOf(db.insert(webhookEvent).values(row))).code).toBe("23505");
  });
});
