import { getAuthorization, voidAuthorization } from "./paypal";
import { gbp, makeWalletHold, type Probe } from "./probe";

/**
 * The smoke run: the token, an order, the buyer's approval, an authorisation
 * and its void, read back. Proves the runner's seams before any probe.
 */
export const smoke: Probe = {
  id: "SMOKE",
  title: "Token, order, approval, void",
  question:
    "Do the token, a £1.00 GBP `AUTHORIZE` order, the headless buyer's approval, the authorisation and its void all work end to end? Pass if the authorisation reads back `VOIDED`.",
  async run(context) {
    const hold = await makeWalletHold(context, "smoke", gbp(100));
    const voided = await voidAuthorization(
      context.client,
      hold.authorization.id,
      context.requestId("smoke", "void"),
    );
    const read = await getAuthorization(context.client, hold.authorization.id);
    const pass = read.status === "VOIDED";
    return {
      verdict: pass ? "pass" : "fail",
      summary: pass
        ? `Order ${hold.orderId} approved, authorised as ${hold.authorization.id} and voided; it reads back VOIDED.`
        : `The void of ${hold.authorization.id} answered, but it reads back ${read.status}.`,
      observations: {
        order: hold.orderId,
        authorization: hold.authorization.id,
        "authorisation status after authorise": hold.authorization.status,
        "void answered": voided === null ? "no content" : voided.status,
        "authorisation status read back": read.status,
      },
      branch: null,
    };
  },
};
