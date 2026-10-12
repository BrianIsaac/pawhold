/*
 * Where the browser suite's database is: the run's own, beside the unit
 * suite's on the development Postgres (compose.yml) or TEST_DATABASE_ADMIN_URL.
 */

const DEFAULT_ADMIN_URL = "postgres://pawhold:pawhold@127.0.0.1:54329/pawhold";

/**
 * The admin database the run's database is made from.
 *
 * @returns The URL.
 */
export function testAdminUrl(): string {
  return process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;
}

/**
 * The run's database, as playwright.config.ts names it.
 *
 * @returns The URL.
 * @throws Error when the run's database is not named.
 */
export function browserDatabaseUrl(): string {
  const name = process.env.PAWHOLD_BROWSER_DATABASE;
  if (!name) {
    throw new Error("the browser suite's database is named by playwright.config.ts");
  }
  const url = new URL(testAdminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}
