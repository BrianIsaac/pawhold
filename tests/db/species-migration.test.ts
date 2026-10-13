import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { revertMigration } from "@/db/revert";

import { DAY_CASES } from "../../seed/practice/day";
import { SHOWCASE_CASE } from "../../seed/practice/showcase";
import { MONEY_STATE_CASES } from "../../seed/showcase/cases";
import { connectAdmin, DEFAULT_ADMIN_URL } from "../setup/database";
import { refusalOf } from "../support/postgres-error";

/*
 * Migration 0015 (U17) on a database that already holds cases, as Render's
 * does: each is kept, a case the seed wrote takes the seed's species and any
 * other becomes "other", the column then has no default, and the way back
 * (two files under `drizzle/revert/`) leaves the database as 0014 left it,
 * from which 0015 runs again.
 */

const DRIZZLE = fileURLToPath(new URL("../../drizzle", import.meta.url));
const FORWARD = join(DRIZZLE, "0015_case_species.sql");
const REVERT_ALLOW = join(DRIZZLE, "revert", "0015_case_species.1-allow-unset.sql");
const REVERT_DROP = join(DRIZZLE, "revert", "0015_case_species.2-drop.sql");

/** The migration before this unit's. */
const BEFORE_SPECIES = "0014_case_vet_row";

/** A journal entry, as far as this test reads it. */
interface JournalEntry {
  readonly tag: string;
}

/**
 * A copy of `drizzle/` whose journal stops at a migration, so a database can
 * be left as it was before a later one.
 *
 * @param lastTag - The last migration the copy keeps.
 * @returns The copy's folder.
 */
function migrationsUpTo(lastTag: string): string {
  const folder = mkdtempSync(join(tmpdir(), "pawhold-migrations-"));
  cpSync(DRIZZLE, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: JournalEntry[] };
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  expect(last, lastTag).toBeGreaterThanOrEqual(0);
  writeFileSync(
    journalPath,
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, last + 1) }),
  );
  return folder;
}

let admin: postgres.Sql;
let name: string;
let url: string;
let sql: postgres.Sql;
let caseId: string;

beforeAll(async () => {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;
  admin = await connectAdmin(adminUrl);
  name = `pawhold_test_species_${randomBytes(6).toString("hex")}`;
  await admin.unsafe(`create database ${name}`);
  const address = new URL(adminUrl);
  address.pathname = `/${name}`;
  url = address.toString();

  const folder = migrationsUpTo(BEFORE_SPECIES);
  const before = createDatabase(url, { max: 1 });
  try {
    await migrate(before.db, { migrationsFolder: folder });
  } finally {
    await before.close();
    rmSync(folder, { recursive: true, force: true });
  }

  sql = postgres(url, { max: 1, onnotice: () => {} });
  const [made] = await sql<{ id: string }[]>`
    insert into practice (name, kind) values ('Before species', 'judge') returning id
  `;
  const practiceId = made!.id;
  await sql`insert into vet (practice_id, name) values (${practiceId}, 'Rowan Hale')`;
  const [kase] = await sql<{ id: string }[]>`
    insert into patient_case (practice_id, patient_name, owner_name, procedure, vet_name)
    values (${practiceId}, 'Biscuit', 'Ann Owner', 'Dental', 'Rowan Hale')
    returning id
  `;
  caseId = kase!.id;
  const opened = async (patient: string, seeded: boolean): Promise<void> => {
    const detail = seeded ? { patientName: patient, seeded } : { patientName: patient };
    const [made] = await sql<{ id: string }[]>`
      insert into patient_case (practice_id, patient_name, owner_name, procedure)
      values (${practiceId}, ${patient}, 'An Owner', 'Spay')
      returning id
    `;
    await sql`
      insert into audit_event (practice_id, case_id, actor, action, money_state_after, detail)
      values (${practiceId}, ${made!.id}, 'vet', 'case.opened', 'estimate_draft', ${sql.json(detail)})
    `;
  };
  await opened("Otis", true);
  await opened("Poppy", false);

  await migrateDatabase(url);
});

afterAll(async () => {
  await sql?.end();
  await admin?.unsafe(`drop database if exists ${name} with (force)`);
  await admin?.end();
});

/**
 * The species column as the catalogue describes it, or null without one.
 *
 * @returns Its type, whether it takes a null, and its default.
 */
async function speciesColumn(): Promise<{
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
} | null> {
  const [column] = await sql<
    { udt_name: string; is_nullable: string; column_default: string | null }[]
  >`
    select udt_name, is_nullable, column_default from information_schema.columns
    where table_name = 'patient_case' and column_name = 'species'
  `;
  return column ?? null;
}

describe("migration 0015, a case's species (U17)", () => {
  it("keeps a case opened before it, word for word, as another animal", async () => {
    const [kase] = await sql`
      select patient_name, owner_name, procedure, vet_name, money_state, species
      from patient_case where id = ${caseId}
    `;

    expect(kase).toEqual({
      patient_name: "Biscuit",
      owner_name: "Ann Owner",
      procedure: "Dental",
      vet_name: "Rowan Hale",
      money_state: "estimate_draft",
      species: "other",
    });
  });

  it("gives a case the seed wrote its seed's species, and a case a vet opened none", async () => {
    const cases = await sql`
      select patient_name, species from patient_case
      where patient_name in ('Otis', 'Poppy') order by patient_name
    `;

    expect(cases).toEqual([
      { patient_name: "Otis", species: "dog" },
      { patient_name: "Poppy", species: "other" },
    ]);
  });

  it("knows each seeded case by the species the seed gives it", () => {
    const forward = readFileSync(FORWARD, "utf8");
    const seeded = [SHOWCASE_CASE, ...DAY_CASES, ...MONEY_STATE_CASES];

    expect(new Set(seeded.map((one) => one.patientName)).size).toBe(seeded.length);
    for (const one of seeded) {
      expect(forward, one.patientName).toContain(`('${one.patientName}', '${one.species}')`);
    }
    expect(forward.match(/\('[A-Z][a-z]+', '(dog|cat|other)'\)/g)).toHaveLength(seeded.length);
  });

  it("leaves the column without a default, so a case names its species from then on", async () => {
    expect(await speciesColumn()).toEqual({
      udt_name: "animal_species",
      is_nullable: "NO",
      column_default: null,
    });
    const [practiceRow] = await sql<{ id: string }[]>`select id from practice limit 1`;

    const { code } = await refusalOf(
      sql`
        insert into patient_case (practice_id, patient_name, owner_name, procedure)
        values (${practiceRow!.id}, 'Pepper', 'Sam Patel', 'Dental')
      `,
    );

    expect(code).toBe("23502");
  });

  it("goes back in two steps, then forward again, keeping every case", async () => {
    const [practiceRow] = await sql<{ id: string }[]>`select id from practice limit 1`;

    await revertMigration(url, REVERT_ALLOW);
    await sql`
      insert into patient_case (practice_id, patient_name, owner_name, procedure)
      values (${practiceRow!.id}, 'Pepper', 'Sam Patel', 'Dental')
    `;
    expect((await speciesColumn())?.column_default).toBe("'other'::animal_species");

    await revertMigration(url, REVERT_DROP);
    expect(await speciesColumn()).toBeNull();
    const [type] = await sql`select 1 from pg_type where typname = 'animal_species'`;
    expect(type).toBeUndefined();
    const [ran] = await sql<{ count: string }[]>`
      select count(*) from drizzle.__drizzle_migrations
    `;
    const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
      entries: JournalEntry[];
    };
    expect(Number(ran!.count)).toBe(journal.entries.length - 1);

    await migrateDatabase(url);
    const cases = await sql`select patient_name, species from patient_case order by patient_name`;
    expect(cases).toEqual([
      { patient_name: "Biscuit", species: "other" },
      { patient_name: "Otis", species: "dog" },
      { patient_name: "Pepper", species: "other" },
      { patient_name: "Poppy", species: "other" },
    ]);
    expect((await speciesColumn())?.column_default).toBeNull();
  });

  it("refuses a way back file from outside `drizzle/revert/`", async () => {
    await expect(revertMigration(url, join(DRIZZLE, "0015_case_species.sql"))).rejects.toThrow(
      /drizzle\/revert/,
    );
  });
});
