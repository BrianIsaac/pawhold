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
  return formatter.format(pence / 100);
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
