/*
 * Where the browser suite's database is: the run's own, made and migrated by
 * tests/browser/run.ts and handed to the server and the workers alike.
 */

/**
 * The run's database, which the owner's walks write their cases into.
 *
 * @returns The URL.
 * @throws Error when the run's database is not set, or is not a browser run's.
 */
export function browserDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || !/^\/pawhold_browser_[0-9a-f]{12}$/.test(new URL(url).pathname)) {
    throw new Error("the browser suite's database is made by `pnpm test:browser`");
  }
  return url;
}
