import { paypalEnvironment, readEnvironment } from "../src/env";
import { createPayPalClient } from "../src/paypal/client";
import { createSmokeOrder } from "../src/paypal/smoke-order";

/*
 * The deployment check owed to U0's day: run on the Render service's shell,
 * `pnpm paypal:smoke-order`, then find the order id in the sandbox business
 * account. Calls PayPal's sandbox; never run without the operator's word.
 */
const paypal = readEnvironment(paypalEnvironment);
const client = createPayPalClient({
  clientId: paypal.PAYPAL_CLIENT_ID,
  clientSecret: paypal.PAYPAL_CLIENT_SECRET,
  environment: paypal.PAYPAL_ENV,
});
const currency = process.env.PAWHOLD_CURRENCY === "USD" ? "USD" : "GBP";
console.info("pawhold: sandbox order created", await createSmokeOrder(client, currency));
