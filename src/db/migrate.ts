import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabase } from "./client";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Applies every migration in `drizzle/` that the database has not yet run.
 *
 * @param url - The Postgres connection URL.
 * @returns Resolves once the database is current.
 */
export async function migrateDatabase(url: string): Promise<void> {
  const database = createDatabase(url, { max: 1 });
  try {
    await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await database.close();
  }
}
