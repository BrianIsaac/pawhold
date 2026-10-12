import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { appendAuditEvent, AuditEventInputError } from "@/audit/writer";
import { auditEvent, patientCase, practice } from "@/db/schema";

import { connectTestDatabase } from "../support/database";
import { refusalOf } from "../support/postgres-error";

const { db } = connectTestDatabase();

let practiceId: string;
let caseId: string;

beforeAll(async () => {
  const [created] = await db
    .insert(practice)
    .values({ name: "Audit practice", kind: "judge" })
    .returning();
  practiceId = created!.id;
  const [kase] = await db
    .insert(patientCase)
    .values({ practiceId, patientName: "Biscuit", ownerName: "A. Owner", procedure: "Dental" })
    .returning();
  caseId = kase!.id;
});

describe("the audit writer", () => {
  it("appends the owner's authorisation as plan 3.5 shows it", async () => {
    const written = await appendAuditEvent(db, {
      practiceId,
      caseId,
      actor: "owner",
      action: "hold.authorised",
      moneyStateBefore: "awaiting_owner",
      moneyStateAfter: "held",
      amount: { pence: 64_000, currency: "GBP" },
      paypal: { orderId: "5O190127TN364715T", authorizationId: "7AB12345CD678901E" },
      webhook: { eventId: null, verified: null },
      detail: { note: "a test event" },
    });

    expect(written.id).toBeGreaterThan(0);
    expect(written.occurredAt).toBeInstanceOf(Date);
    expect(written.amountPence).toBe(64_000);
    expect(written.currencyCode).toBe("GBP");
    expect(written.paypalAuthorizationId).toBe("7AB12345CD678901E");
  });

  it("records a model step with its model id, input hash and validated output", async () => {
    const written = await appendAuditEvent(db, {
      practiceId,
      caseId,
      actor: "system",
      action: "estimate.drafted",
      model: {
        id: "claude-opus-5-5",
        inputSha256: "a".repeat(64),
        output: { lines: [] },
      },
    });

    expect(written.modelId).toBe("claude-opus-5-5");
    expect(written.modelOutput).toEqual({ lines: [] });
  });

  it("refuses money that is not whole, non-negative pence", async () => {
    const base = { practiceId, caseId, actor: "vet", action: "bill.line_added" } as const;

    await expect(
      appendAuditEvent(db, { ...base, amount: { pence: 12.5, currency: "GBP" } }),
    ).rejects.toBeInstanceOf(AuditEventInputError);
    await expect(
      appendAuditEvent(db, { ...base, amount: { pence: -1, currency: "GBP" } }),
    ).rejects.toBeInstanceOf(AuditEventInputError);
  });

  it("refuses an action that is not a dotted lower-case name", async () => {
    await expect(
      appendAuditEvent(db, { practiceId, actor: "system", action: "Hold Authorised" }),
    ).rejects.toBeInstanceOf(AuditEventInputError);
  });

  it("refuses a case without its practice", async () => {
    await expect(
      appendAuditEvent(db, { caseId, actor: "system", action: "case.opened" }),
    ).rejects.toBeInstanceOf(AuditEventInputError);
  });
});

describe("the audit table at the database", () => {
  it("refuses an UPDATE", async () => {
    const written = await appendAuditEvent(db, {
      practiceId,
      actor: "system",
      action: "case.opened",
    });

    const refused = await refusalOf(
      db.update(auditEvent).set({ action: "case.closed" }).where(eq(auditEvent.id, written.id)),
    );

    expect(refused.code).toBe("23001");
    expect(refused.message).toBe("audit_event is append-only: UPDATE refused");
    const [row] = await db.select().from(auditEvent).where(eq(auditEvent.id, written.id));
    expect(row!.action).toBe("case.opened");
  });

  it("refuses a DELETE", async () => {
    const written = await appendAuditEvent(db, {
      practiceId,
      actor: "system",
      action: "case.opened",
    });

    const refused = await refusalOf(db.delete(auditEvent).where(eq(auditEvent.id, written.id)));

    expect(refused.code).toBe("23001");
    expect(refused.message).toBe("audit_event is append-only: DELETE refused");
    expect(await db.select().from(auditEvent).where(eq(auditEvent.id, written.id))).toHaveLength(1);
  });

  it("refuses a TRUNCATE", async () => {
    const refused = await refusalOf(db.execute(sql`truncate audit_event cascade`));

    expect(refused.code).toBe("23001");
    expect(refused.message).toBe("audit_event is append-only: TRUNCATE refused");
  });

  it("refuses a raw UPDATE that sidesteps the writer", async () => {
    const refused = await refusalOf(db.execute(sql`update audit_event set detail = '{}'::jsonb`));

    expect(refused.code).toBe("23001");
  });
});
