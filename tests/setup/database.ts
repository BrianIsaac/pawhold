import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import postgres from "postgres";
import type { TestProject } from "vitest/node";

import { migrateDatabase } from "../../src/db/migrate";

const DEFAULT_ADMIN_URL = "postgres://pawhold:pawhold@127.0.0.1:54329/pawhold";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Opens a connection to the admin database, starting the development
 * Postgres in Docker first when it is not reachable outside CI.
 *
 * @param adminUrl - The URL of a database the test role can create databases from.
 * @returns A connection to the admin database.
 */
async function connectAdmin(adminUrl: string): Promise<postgres.Sql> {
  const tryConnect = async (): Promise<postgres.Sql> => {
    const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await sql`select 1`;
    return sql;
  };
  try {
    return await tryConnect();
  } catch (error) {
    if (process.env.CI) {
      throw error;
    }
    execFileSync("docker", ["compose", "up", "-d", "--wait", "db"], { stdio: "inherit" });
    return tryConnect();
  }
}

/**
 * Creates a fresh test database for this run, migrates it, and hands its URL
 * to the tests. The database is dropped when the run ends, so concurrent runs
 * never share one.
 *
 * @param project - The Vitest project, used to provide the database URL.
 * @returns The teardown that drops the database.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;
  const admin = await connectAdmin(adminUrl);
  const name = `pawhold_test_${randomBytes(6).toString("hex")}`;
  await admin.unsafe(`create database ${name}`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  await migrateDatabase(databaseUrl);
  project.provide("databaseUrl", databaseUrl);

  return async () => {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end();
  };
}
