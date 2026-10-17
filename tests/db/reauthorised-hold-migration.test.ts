import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { eq, sql as drizzleSql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { revertMigration } from "@/db/revert";
import { hold } from "@/db/schema";

import { connectAdmin, DEFAULT_ADMIN_URL } from "../setup/database";
import { DRIZZLE, journalIndex, migrationsUpTo } from "../support/migrations";
import { makeDentalCase, sendVersionDirectly } from "../support/money";
import { refusalOf } from "../support/postgres-error";

/*
 * Migration 0016 (U3b) on a database that already holds holds, as Render's
 * does: before it a card hold cannot be reauthorised, after it a wallet or a
 * card hold can, onto a new authorisation only; the way back
 * (`drizzle/revert/0016_hold_reauthorised_any_kind.sql`) brings the
 * wallet-only check back for rows written from then on, keeps a card hold
 * already reauthorised, and leaves the database from which 0016 runs again.
 */

const REVERT = join(DRIZZLE, "revert", "0016_hold_reauthorised_any_kind.sql");

/** The migration before this unit's. */
const BEFORE = "0015_case_species";

/** This unit's migration. */
const REAUTHORISED_ANY_KIND = "0016_hold_reauthorised_any_kind";

let admin: postgres.Sql;
let name: string;
let url: string;
let database: Database;

/**
 * Writes an authorised hold, of the given kind, on a case of its own.
 *
 * @param kind - How the owner paid.
 * @returns The hold's id.
 */
async function authorisedHold(kind: "paypal" | "card"): Promise<string> {
  const fixture = await makeDentalCase(database.db, `Before U3b, ${kind}`);
  const version = await sendVersionDirectly(database.db, fixture);
  await database.db.insert(hold).values({
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
    paymentKind: kind,
    authorisedAt: new Date("2026-10-12T11:42:30Z"),
    expiresAt: new Date("2026-11-10T11:42:30Z"),
  });
  return version.id;
}

/**
 * Reauthorises a hold as the job records it, onto the given authorisation.
 *
 * @param holdId - The hold.
 * @param authorizationId - The authorisation it goes onto.
 * @returns The update.
 */
function reauthorise(holdId: string, authorizationId = `RE-${holdId.slice(0, 8)}`) {
  return database.db
    .update(hold)
    .set({ authorizationId, reauthorisedAt: new Date("2026-10-17T00:00:46Z") })
    .where(eq(hold.id, holdId));
}

/**
 * The hold table's reauthorisation checks, as the catalogue holds them.
 *
 * @returns Each check's name and whether every row was held to it.
 */
async function reauthorisationChecks(): Promise<{ conname: string; convalidated: boolean }[]> {
  return database.db.execute<{ conname: string; convalidated: boolean }>(drizzleSql`
    select conname, convalidated from pg_constraint
    where conrelid = 'hold'::regclass and conname like 'hold_reauthorised_%'
    order by conname`);
}

let card: string;

beforeAll(async () => {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;
  admin = await connectAdmin(adminUrl);
  name = `pawhold_test_reauthorised_${randomBytes(6).toString("hex")}`;
  await admin.unsafe(`create database ${name}`);
  const address = new URL(adminUrl);
  address.pathname = `/${name}`;
  url = address.toString();

  const folder = migrationsUpTo(BEFORE);
  database = createDatabase(url, { max: 1 });
  try {
    await migrate(database.db, { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  card = await authorisedHold("card");
});

afterAll(async () => {
  await database?.close();
  await admin?.unsafe(`drop database if exists ${name} with (force)`);
  await admin?.end();
});

describe("migration 0016, a card hold reauthorised as a wallet hold is (U3b)", () => {
  it("refuses a card hold's reauthorisation before it", async () => {
    const { message } = await refusalOf(reauthorise(card));

    expect(message).toContain("hold_reauthorised_wallet_only");
  });

  it("lets a card hold be reauthorised after it, onto a new authorisation only", async () => {
    await migrateDatabase(url);

    const { message } = await refusalOf(reauthorise(card, `AUTH-${card.slice(0, 8)}`));
    expect(message).toContain("hold_reauthorised_new_authorisation");
    await reauthorise(card);
    const [row] = await database.db.select().from(hold).where(eq(hold.id, card));
    expect(row).toMatchObject({ paymentKind: "card", authorizationId: `RE-${card.slice(0, 8)}` });
    expect(await reauthorisationChecks()).toEqual([
      { conname: "hold_reauthorised_new_authorisation", convalidated: true },
    ]);
  });

  it("goes back keeping the reauthorised card hold, refusing the next, then forward again", async () => {
    const nextCard = await authorisedHold("card");
    const wallet = await authorisedHold("paypal");

    await revertMigration(url, REVERT);

    expect(await reauthorisationChecks()).toEqual([
      { conname: "hold_reauthorised_wallet_only", convalidated: false },
    ]);
    const [kept] = await database.db.select().from(hold).where(eq(hold.id, card));
    expect(kept?.reauthorisedAt).not.toBeNull();
    const { message } = await refusalOf(reauthorise(nextCard));
    expect(message).toContain("hold_reauthorised_wallet_only");
    await reauthorise(wallet);
    const [ran] = await database.db.execute<{ count: string }>(
      drizzleSql`select count(*) from drizzle.__drizzle_migrations`,
    );
    expect(Number(ran!.count)).toBe(journalIndex(REAUTHORISED_ANY_KIND));

    await migrateDatabase(url);
    expect(await reauthorisationChecks()).toEqual([
      { conname: "hold_reauthorised_new_authorisation", convalidated: true },
    ]);
    await reauthorise(nextCard);
  });
});
