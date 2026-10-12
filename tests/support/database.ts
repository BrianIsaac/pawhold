import { afterAll, inject } from "vitest";

import { createDatabase, type Database } from "../../src/db/client";

/**
 * Connects to this run's test database for the calling test file and closes
 * the connection after its last test.
 *
 * @returns The database handle.
 */
export function connectTestDatabase(): Database {
  const database = createDatabase(inject("databaseUrl"), { max: 4 });
  afterAll(async () => {
    await database.close();
  });
  return database;
}
