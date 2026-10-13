import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

/** Where a migration's way back is kept: one or more files per migration, run by hand. */
export const REVERT_FOLDER = fileURLToPath(new URL("../../drizzle/revert", import.meta.url));

/** How drizzle-kit separates a migration's statements, kept in the way back's files. */
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * Runs one step of a migration's way back: a file of `drizzle/revert/`, its
 * statements in one transaction, so a step is taken whole or not at all.
 *
 * @param url - The Postgres connection URL.
 * @param file - The step's file, under `drizzle/revert/`.
 * @returns Resolves once the step is committed.
 * @throws Error when the file is not a `.sql` file of `drizzle/revert/`.
 */
export async function revertMigration(url: string, file: string): Promise<void> {
  const path = resolve(file);
  const within = relative(REVERT_FOLDER, path);
  if (within.startsWith("..") || within.includes(sep) || !within.endsWith(".sql")) {
    throw new Error(`a way back is a .sql file of drizzle/revert/, not ${file}`);
  }
  const statements = (await readFile(path, "utf8"))
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      for (const statement of statements) {
        await tx.unsafe(statement);
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
