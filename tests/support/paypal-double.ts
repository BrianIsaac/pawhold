import { afterAll, afterEach, beforeAll } from "vitest";

import { createPayPalDouble, type PayPalDouble } from "./paypal-double-server";

export type {
  DoubleAuthorization,
  DoubleCapture,
  DoubleOrder,
  DoubleRequest,
  InjectedAnswer,
  PayPalDouble,
} from "./paypal-double-server";

/**
 * Starts U3's PayPal double for the calling test file; its state and
 * requests reset after each test.
 *
 * @returns The double.
 */
export function startPayPalDouble(): PayPalDouble {
  const double = createPayPalDouble();
  beforeAll(async () => {
    await double.listen();
  });
  afterEach(() => {
    double.reset();
  });
  afterAll(async () => {
    await double.close();
  });
  return double;
}
