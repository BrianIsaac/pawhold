import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Schema = typeof schema;

/** A Drizzle handle over one connection pool, and the means to close it. */
export interface Database {
  readonly db: PostgresJsDatabase<Schema>;
  readonly close: () => Promise<void>;
}

/** The pool's options this application sets. */
export interface DatabaseOptions {
  /** The most connections the pool opens. */
  readonly max?: number;
}

/**
 * Opens a connection pool to Postgres and wraps it in Drizzle with the
 * application's schema.
 *
 * @param url - The Postgres connection URL.
 * @param options - Pool options.
 * @returns The database handle.
 */
export function createDatabase(url: string, options: DatabaseOptions = {}): Database {
  const client = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    connection: { application_name: "pawhold" },
  });
  return {
    db: drizzle(client, { schema, casing: "snake_case" }),
    close: () => client.end({ timeout: 5 }),
  };
}
