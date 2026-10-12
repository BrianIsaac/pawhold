import type { PriceCategory } from "@/estimate/price-list";

/** What the model is told of a price list item: never its price. */
export interface PromptItem {
  readonly code: string;
  readonly name: string;
  readonly category: PriceCategory;
  readonly unit: string;
}

/**
 * The price list as the prompt carries it: one item a line as
 * `code | name | category | per unit`, sorted by code,
 * so the same list always writes the same text and the cached prefix holds.
 * Prices are left out: the model never sees or writes money.
 *
 * @param items - The practice's items.
 * @returns The list's text.
 */
export function priceListBlock(items: Iterable<PromptItem>): string {
  const rows = [...items]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((item) => `${item.code} | ${item.name} | ${item.category} | per ${item.unit}`);
  return rows.join("\n");
}
