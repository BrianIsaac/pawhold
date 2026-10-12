import { z } from "zod";

/** The currencies pawhold works in: GBP by D1, USD on its forced branch. */
export const CURRENCY_CODES = ["GBP", "USD"] as const;

export const currencyCode = z.enum(CURRENCY_CODES);

export type CurrencyCode = z.infer<typeof currencyCode>;

/** The largest amount a Postgres `integer` column holds, in pence. */
export const MAX_PENCE = 2_147_483_647;

/** An amount of money in integer minor units (pence or cents) and its currency. */
export const money = z.strictObject({
  pence: z.int().nonnegative().max(MAX_PENCE),
  currency: currencyCode,
});

export type Money = z.infer<typeof money>;
