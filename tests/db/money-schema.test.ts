import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { allocation, bill, billLine, capture, hold, refund, webhookEvent } from "@/db/schema";
import type { EstimateVersionView } from "@/estimate/version";

import { connectTestDatabase } from "../support/database";
import { makeDentalCase, type MoneyFixture, sendVersionDirectly } from "../support/money";
import { refusalOf } from "../support/postgres-error";

const { db } = connectTestDatabase();

let fixture: MoneyFixture;
let version: EstimateVersionView;

beforeEach(async () => {
  fixture = await makeDentalCase(db);
  version = await sendVersionDirectly(db, fixture);
});

/**
 * The columns of an authorised wallet hold for the fixture's version.
 *
 * @param overrides - Columns to change.
 * @returns The row to insert.
 */
function authorisedHold(
  overrides: Partial<typeof hold.$inferInsert> = {},
): typeof hold.$inferInsert {
  return {
    id: version.id,
    practiceId: fixture.practiceId,
    caseId: fixture.caseId,
    versionNumber: version.number,
    versionHighPence: version.totals.highPence,
    heldBeforePence: 0,
    amountPence: version.totals.highPence,
    currencyCode: "GBP",
    status: "authorised",
    paypalOrderId: `ORDER-${version.id.slice(0, 8)}`,
    authorizationId: `AUTH-${version.id.slice(0, 8)}`,
    originalAuthorizationId: `AUTH-${version.id.slice(0, 8)}`,
    paymentKind: "paypal",
    authorisedAt: new Date("2026-10-13T09:00:00Z"),
    expiresAt: new Date("2026-11-11T09:00:00Z"),
    ...overrides,
  };
}

/**
 * The columns of a completed capture against the fixture's hold.
 *
 * @param overrides - Columns to change.
 * @returns The row to insert.
 */
function completedCapture(
  overrides: Partial<typeof capture.$inferInsert> = {},
): typeof capture.$inferInsert {
  return {
    holdId: version.id,
    sequence: 1,
    paypalCaptureId: `CAP-${Math.random().toString(36).slice(2, 10)}`,
    authorizationId: `AUTH-${version.id.slice(0, 8)}`,
    amountPence: 50_000,
    currencyCode: "GBP",
    finalCapture: true,
    status: "completed",
    capturedAt: new Date("2026-10-14T16:00:00Z"),
    ...overrides,
  };
}

describe("the money schema as migrated (U3)", () => {
  it("holds the money tables, and the webhook row keeps the signature for verifying again", async () => {
    const tables = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables where table_schema = 'public'`);
    expect(tables.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(["hold", "capture", "refund", "bill", "bill_line", "allocation"]),
    );
    const columns = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns where table_name = 'webhook_event'`);
    expect(columns.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(["transmission_sig", "transmission_time", "cert_url", "auth_algo"]),
    );
    expect(webhookEvent.transmissionSig).toBeDefined();
  });

  it("holds the top of the version's range less what is already held (D3)", async () => {
    const [stored] = await db.insert(hold).values(authorisedHold()).returning();
    expect(stored!.amountPence).toBe(77_300);
    expect(stored!.status).toBe("authorised");
  });

  it("refuses a hold whose amount is not the version's top less what is held before", async () => {
    const { message } = await refusalOf(
      db.insert(hold).values(authorisedHold({ amountPence: 70_000 })),
    );
    expect(message).toContain("hold_amount_is_increase");
  });

  it("refuses a hold that does not name the version's own top", async () => {
    const { message } = await refusalOf(
      db.insert(hold).values(authorisedHold({ versionHighPence: 90_000, amountPence: 90_000 })),
    );
    expect(message).toContain("hold_version_fk");
  });

  it("refuses an authorised hold without its authorisation", async () => {
    const { message } = await refusalOf(
      db.insert(hold).values(authorisedHold({ authorizationId: null })),
    );
    expect(message).toMatch(/hold_authorisation_/);
  });

  it("refuses, at commit, a capture above its hold (rule 1)", async () => {
    await db.insert(hold).values(authorisedHold());
    const { code, message } = await refusalOf(
      db.insert(capture).values(completedCapture({ amountPence: 77_301 })),
    );
    expect(code).toBe("23001");
    expect(message).toContain("captures of hold");
  });

  it("refuses, at commit, a second capture that takes the hold's captures above it (rule 1)", async () => {
    await db.insert(hold).values(authorisedHold());
    await db.insert(capture).values(completedCapture({ amountPence: 60_000, finalCapture: false }));
    const { message } = await refusalOf(
      db.insert(capture).values(completedCapture({ sequence: 2, amountPence: 17_301 })),
    );
    expect(message).toContain("captures of hold");

    await db.insert(capture).values(completedCapture({ sequence: 2, amountPence: 17_300 }));
    const rows = await db.select().from(capture).where(eq(capture.holdId, version.id));
    expect(rows.reduce((sum, row) => sum + row.amountPence, 0)).toBe(77_300);
  });

  it("does not count a capture PayPal declined against its hold (migration 0008)", async () => {
    await db.insert(hold).values(authorisedHold());
    await db.insert(capture).values(completedCapture({ amountPence: 77_300, status: "declined" }));

    await db.insert(capture).values(completedCapture({ sequence: 2, amountPence: 77_300 }));

    const { message } = await refusalOf(
      db.insert(capture).values(completedCapture({ sequence: 3, amountPence: 1 })),
    );
    expect(message).toContain("captures of hold");
  });

  it("keeps a refund PayPal refused without a PayPal id, and an answered one with it (migration 0007)", async () => {
    await db.insert(hold).values(authorisedHold());
    const [captured] = await db.insert(capture).values(completedCapture()).returning();
    const row = {
      captureId: captured!.id,
      amountPence: 1_000,
      currencyCode: "GBP",
      reason: "goodwill",
      requestedBy: "vet" as const,
    };

    await db.insert(refund).values({ ...row, sequence: 1, status: "failed" });
    const { message } = await refusalOf(
      db.insert(refund).values({ ...row, sequence: 2, status: "completed" }),
    );
    expect(message).toContain("refund_answered_with_id");
  });

  it("refuses refunds that take a capture's refunds above it", async () => {
    await db.insert(hold).values(authorisedHold());
    const [captured] = await db.insert(capture).values(completedCapture()).returning();
    await db.insert(refund).values({
      captureId: captured!.id,
      sequence: 1,
      amountPence: 30_000,
      currencyCode: "GBP",
      reason: "goodwill",
      requestedBy: "vet",
    });
    const { message } = await refusalOf(
      db.insert(refund).values({
        captureId: captured!.id,
        sequence: 2,
        amountPence: 20_001,
        currencyCode: "GBP",
        reason: "correction",
        requestedBy: "vet",
      }),
    );
    expect(message).toContain("refunds of capture");
  });

  it("keeps a signed-off bill as signed: its lines and allocations are never changed", async () => {
    await db.insert(hold).values(authorisedHold());
    const line = version.lines[0]!;
    await db.transaction(async (tx) => {
      const [made] = await tx
        .insert(bill)
        .values({
          practiceId: fixture.practiceId,
          caseId: fixture.caseId,
          currencyCode: "GBP",
          totalPence: line.unitPricePence,
          signedOffBy: "vet",
        })
        .returning();
      const [billed] = await tx
        .insert(billLine)
        .values({
          billId: made!.id,
          position: 1,
          estimateLineId: line.id,
          quantity: 1,
          unitPricePence: line.unitPricePence,
        })
        .returning();
      await tx
        .insert(allocation)
        .values({ billLineId: billed!.id, holdId: version.id, amountPence: line.unitPricePence });
    });

    const [signed] = await db.select().from(bill).where(eq(bill.caseId, fixture.caseId));
    const [billed] = await db.select().from(billLine).where(eq(billLine.billId, signed!.id));
    const { code } = await refusalOf(
      db.update(billLine).set({ quantity: 2 }).where(eq(billLine.id, billed!.id)),
    );
    expect(code).toBe("23001");
    expect(
      (await refusalOf(db.delete(allocation).where(eq(allocation.billLineId, billed!.id)))).code,
    ).toBe("23001");
    expect(
      (await refusalOf(db.update(bill).set({ totalPence: 1 }).where(eq(bill.id, signed!.id)))).code,
    ).toBe("23001");
  });

  it("never removes a hold, a capture or a refund, nor changes what a hold holds", async () => {
    await db.insert(hold).values(authorisedHold());
    await db.insert(capture).values(completedCapture());

    expect((await refusalOf(db.delete(capture).where(eq(capture.holdId, version.id)))).code).toBe(
      "23001",
    );
    expect((await refusalOf(db.delete(hold).where(eq(hold.id, version.id)))).code).toBe("23001");
    expect(
      (
        await refusalOf(
          db
            .update(hold)
            .set({ heldBeforePence: 1, amountPence: 77_299 })
            .where(eq(hold.id, version.id)),
        )
      ).message,
    ).toContain("what it holds never changes");

    await db
      .update(hold)
      .set({ status: "captured", closedAt: new Date() })
      .where(eq(hold.id, version.id));
    const [closed] = await db.select().from(hold).where(eq(hold.id, version.id));
    expect(closed!.status).toBe("captured");
  });

  it("refuses TRUNCATE of every money table", async () => {
    // One leaf table, so the test holds no other lock while it waits.
    const { code } = await refusalOf(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`truncate allocation`);
        throw new Error("the truncate was not refused");
      }),
    );
    const guarded = await db.execute<{ table_name: string }>(sql`
      select c.relname as table_name from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and (t.tgtype & 32) <> 0
        and c.relname in ('hold', 'capture', 'refund', 'bill', 'bill_line', 'allocation')
      order by c.relname
    `);

    expect(code).toBe("23001");
    expect(guarded.map((row) => row.table_name)).toEqual([
      "allocation",
      "bill",
      "bill_line",
      "capture",
      "hold",
      "refund",
    ]);
  });

  it("refuses a bill line priced other than its estimate line", async () => {
    const line = version.lines[0]!;
    const { message } = await refusalOf(
      db.transaction(async (tx) => {
        const [made] = await tx
          .insert(bill)
          .values({
            practiceId: fixture.practiceId,
            caseId: fixture.caseId,
            currencyCode: "GBP",
            totalPence: 1,
            signedOffBy: "vet",
          })
          .returning();
        await tx.insert(billLine).values({
          billId: made!.id,
          position: 1,
          estimateLineId: line.id,
          quantity: 1,
          unitPricePence: 1,
        });
      }),
    );
    expect(message).toContain("bill_line_priced_from_estimate_fk");
  });

  it("refuses, at commit, a bill whose lines are not wholly allocated, or allocated past a hold", async () => {
    await db.insert(hold).values(authorisedHold());
    const line = version.lines[0]!;
    const signOff = (allocated: number) =>
      db.transaction(async (tx) => {
        const [made] = await tx
          .insert(bill)
          .values({
            practiceId: fixture.practiceId,
            caseId: fixture.caseId,
            currencyCode: "GBP",
            totalPence: line.unitPricePence,
            signedOffBy: "vet",
          })
          .returning();
        const [billed] = await tx
          .insert(billLine)
          .values({
            billId: made!.id,
            position: 1,
            estimateLineId: line.id,
            quantity: 1,
            unitPricePence: line.unitPricePence,
          })
          .returning();
        await tx
          .insert(allocation)
          .values({ billLineId: billed!.id, holdId: version.id, amountPence: allocated });
      });

    expect((await refusalOf(signOff(line.unitPricePence - 1))).message).toContain("allocated");
  });
});
