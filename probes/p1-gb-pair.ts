import { getOrder, pence, voidAuthorization } from "./paypal";
import { gbp, makeWalletHold, type Probe } from "./probe";

/**
 * P1. A GB sandbox pair: a £100.00 GBP `AUTHORIZE` order approved by the GB
 * personal account and authorised for the app's GB business account. The
 * accounts' existence and countries were made and checked in the dashboard
 * (the operator's and the cockpit's part); the script proves the pair works.
 */
export const p1: Probe = {
  id: "P1",
  title: "A GB sandbox pair",
  question:
    "Can a £100.00 GBP order with `intent: AUTHORIZE` be approved by the GB personal sandbox account and authorised for the app's GB business account? Pass if the authorisation is `CREATED` for GBP 100.00 and the payer's country is GB.",
  async run(context) {
    const hold = await makeWalletHold(context, "p1", gbp(10_000));
    const order = await getOrder(context.client, hold.orderId);
    const payer = order.payment_source?.paypal;
    const voided = await voidAuthorization(
      context.client,
      hold.authorization.id,
      context.requestId("p1", "void"),
    );
    const currency = hold.authorization.amount?.currency_code ?? null;
    const held = pence(hold.authorization.amount);
    const country = payer?.address?.country_code ?? null;
    const pass =
      hold.authorization.status === "CREATED" &&
      currency === "GBP" &&
      held === 10_000 &&
      country === "GB";
    return {
      verdict: pass ? "pass" : "fail",
      summary: pass
        ? `The GB buyer approved order ${hold.orderId}; it authorised as ${hold.authorization.id} for GBP 100.00, then voided.`
        : `Order ${hold.orderId} authorised as ${hold.authorization.status} for ${currency} ${held ?? "?"} with payer country ${country ?? "unread"}.`,
      observations: {
        order: hold.orderId,
        authorization: hold.authorization.id,
        "authorisation status": hold.authorization.status,
        "held (pence)": held,
        currency,
        "payer country": country,
        "payer account status": payer?.account_status ?? null,
        "authorisation expires": hold.authorization.expiration_time ?? null,
        "order status after authorise": order.status,
        "void answered": voided?.status ?? "no content",
      },
      branch: pass
        ? null
        : "USD on a US pair (the research's default path); the UK story told in the copy and D1 recorded as forced.",
    };
  },
};
