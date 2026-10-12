import { z } from "zod";

import { type CurrencyCode, currencyCode } from "./currency";

const formatters = new Map<CurrencyCode, Intl.NumberFormat>();

const signedMoney = z.strictObject({ pence: z.int(), currency: currencyCode });

/**
 * Money as the screens show it: integer pence as pounds and pence, in British
 * English ("£1,147.00"; "US$500.00" on the USD branch), signed when negative.
 * Every amount a screen shows is computed by code and formatted here; none is
 * written by the model (plan section 6).
 *
 * @param money - Whole pence (or cents), signed, and the currency.
 * @param money.pence - The amount.
 * @param money.currency - Its currency.
 * @returns The amount in words a person reads.
 * @throws ZodError when the amount is not whole minor units.
 */
export function formatMoney(money: { pence: number; currency: CurrencyCode }): string {
  const { pence, currency } = signedMoney.parse(money);
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    formatters.set(currency, formatter);
  }
  // Pence are divided exactly: a safe integer over 100 has at most two decimals.
  return formatter.format(pence / 100);
}

/**
 * An amount the owner is asked for, held for or paid, which is never
 * negative: as `formatMoney`, refusing a negative amount rather than showing
 * an owner a minus sign.
 *
 * @param pence - The amount in minor units: a whole, non-negative number.
 * @param currency - The currency.
 * @returns The amount as text.
 * @throws RangeError when the amount is not whole, non-negative pence.
 */
export function formatPence(pence: number, currency: CurrencyCode): string {
  if (!Number.isSafeInteger(pence) || pence < 0) {
    throw new RangeError(`${pence} is not a whole, non-negative number of pence`);
  }
  return formatMoney({ pence, currency });
}

/**
 * A share in basis points as a percentage's number: whole when it is whole,
 * else to one decimal place, always rounded down, so a share below the
 * Order's 20% is never shown as 20 (U2's finding 4).
 *
 * @param basisPoints - The share, in hundredths of a per cent.
 * @returns The number, without the sign.
 */
export function formatPercent(basisPoints: number): string {
  const tenths = Math.floor(basisPoints / 10);
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}
