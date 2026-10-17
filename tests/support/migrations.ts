import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's migrations, as drizzle-kit writes them. */
export const DRIZZLE = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** A journal entry, as far as these helpers read it. */
interface JournalEntry {
  readonly tag: string;
}

/**
 * Where a migration stands in the repository's journal: also how many
 * migrations ran before it.
 *
 * @param tag - The migration.
 * @returns Its index.
 * @throws Error when the journal does not name it.
 */
export function journalIndex(tag: string): number {
  const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 0) {
    throw new Error(`drizzle's journal names no migration ${tag}`);
  }
  return index;
}

/**
 * A copy of `drizzle/` whose journal stops at a migration, so a database can
 * be left as it was before a later one. The caller removes the copy.
 *
 * @param lastTag - The last migration the copy keeps.
 * @returns The copy's folder.
 * @throws Error when the journal does not name the migration.
 */
export function migrationsUpTo(lastTag: string): string {
  const last = journalIndex(lastTag);
  const folder = mkdtempSync(join(tmpdir(), "pawhold-migrations-"));
  cpSync(DRIZZLE, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: JournalEntry[] };
  writeFileSync(
    journalPath,
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, last + 1) }),
  );
  return folder;
}
