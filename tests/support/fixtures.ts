import { readFileSync } from "node:fs";

const ROOT = new URL("../fixtures/paypal/", import.meta.url);

/**
 * Reads a PayPal fixture's bytes exactly as stored.
 *
 * @param path - The path under `tests/fixtures/paypal/`.
 * @returns The file's contents.
 */
export function paypalFixtureText(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

/**
 * Reads and parses a JSON PayPal fixture.
 *
 * @param path - The path under `tests/fixtures/paypal/`.
 * @returns The parsed JSON.
 */
export function paypalFixture(path: string): unknown {
  return JSON.parse(paypalFixtureText(path));
}
