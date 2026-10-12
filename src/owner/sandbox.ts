import { z } from "zod";

/**
 * PayPal's GB "Test Case 1" Visa, from PayPal's sandbox card testing page
 * (U0's decision 13, P6): the card the owner's page offers in judge mode.
 * It is PayPal's published test card, not a secret.
 */
export const SANDBOX_TEST_CARD = {
  number: "4462603042343024",
  expiry: "12/30",
  cvv: "123",
} as const;

/** The GB sandbox personal account a judge logs in to PayPal with (plan 7.4). */
export interface SandboxBuyerLogin {
  readonly email: string;
  readonly password: string;
}

const sandboxBuyerEnvironment = z.object({
  PAYPAL_SANDBOX_BUYER_EMAIL: z.email(),
  PAYPAL_SANDBOX_BUYER_PASSWORD: z.string().min(1).max(128),
});

/**
 * The sandbox buyer's login from the server's environment, which the
 * testing instructions publish (the rules ask for "sandbox login details");
 * it is never written into the code.
 *
 * @param source - The environment; `process.env` by default.
 * @returns The login, or null when it is not set whole and well formed.
 */
export function readSandboxBuyer(
  source: Record<string, string | undefined> = process.env,
): SandboxBuyerLogin | null {
  const parsed = sandboxBuyerEnvironment.safeParse(source);
  return parsed.success
    ? {
        email: parsed.data.PAYPAL_SANDBOX_BUYER_EMAIL,
        password: parsed.data.PAYPAL_SANDBOX_BUYER_PASSWORD,
      }
    : null;
}

/**
 * A card number in groups of four, as it is printed on a card.
 *
 * @param number - The digits.
 * @returns The grouped number.
 */
export function groupedCardNumber(number: string): string {
  return number.replace(/(\d{4})(?=\d)/g, "$1 ");
}
