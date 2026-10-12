import { z } from "zod";

import { MAX_PENCE } from "./currency";

const pence = z.int().nonnegative().max(MAX_PENCE);

/**
 * Writes an amount in pence as PayPal's `amount.value` string, two decimal
 * places, without passing through a floating-point division.
 *
 * @param amount - Whole, non-negative pence.
 * @returns The value, such as `640.00`.
 * @throws ZodError when the amount is not whole, non-negative pence.
 */
export function toPayPalValue(amount: number): string {
  const whole = pence.parse(amount);
  return `${Math.trunc(whole / 100)}.${String(whole % 100).padStart(2, "0")}`;
}
