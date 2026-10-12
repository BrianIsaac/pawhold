import { randomBytes } from "node:crypto";

/**
 * The prefix of every PayPal-shaped id a seed writes (U5, U8a, U9): an order,
 * authorisation, capture or refund that PayPal never made. Nothing with this
 * prefix is ever sent to PayPal; PayPal's own ids are upper-case letters and
 * digits that never begin so.
 */
export const SEEDED_ID_PREFIX = "SEEDED";

/**
 * Whether a PayPal id is one a seed wrote.
 *
 * @param id - The id.
 * @returns True when it begins `SEEDED`.
 */
export function isSeededPayPalId(id: string): boolean {
  return id.startsWith(SEEDED_ID_PREFIX);
}

/**
 * A PayPal-shaped id that says it is seeded: `SEEDED` and ten upper-case hex
 * digits, as U5's and U8a's seeds make them.
 *
 * @returns The id.
 */
export function seededPayPalId(): string {
  return `${SEEDED_ID_PREFIX}${randomBytes(5).toString("hex").toUpperCase()}`;
}
