import type { CurrencyCode, Money } from "./currency";

const formatters = new Map<CurrencyCode, Intl.NumberFormat>();

/**
 * Shows an amount in integer pence (or cents) as the screens show money: the
 * currency's symbol, thousands separated, two decimals, in British English
 * ("£1,159.00").
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
 * Shows an amount of money.
 *
 * @param money - The amount and its currency.
 * @returns The amount as text.
 */
export function formatMoney(money: Money): string {
  return formatPence(money.pence, money.currency);
}
