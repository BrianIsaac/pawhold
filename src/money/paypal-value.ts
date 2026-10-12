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

const PAYPAL_VALUE = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

const paypalValue = z
  .string()
  .regex(PAYPAL_VALUE, "an amount value: whole units and at most two decimal places");

/**
 * Reads PayPal's `amount.value` string (a GBP or USD amount, at most two
 * decimal places) as whole pence, without passing through a floating-point
 * multiplication.
 *
 * @param value - PayPal's value, such as `64.00`.
 * @returns The amount in pence.
 * @throws ZodError when the value is not a non-negative amount with at most two decimals, or exceeds the largest amount held.
 */
export function fromPayPalValue(value: string): number {
  const [, units = "0", fraction = ""] = PAYPAL_VALUE.exec(paypalValue.parse(value)) ?? [];
  return pence.parse(Number(units) * 100 + Number(fraction.padEnd(2, "0")));
}
