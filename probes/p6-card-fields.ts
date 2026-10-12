import type { TestCard } from "./buyer";
import { authorizeOrder, onlyAuthorization } from "@/paypal/orders";
import { captureAuthorization, getAuthorization, pence } from "@/paypal/payments";
import { createProbeOrder } from "./orders";
import { P5_LATER_DATE } from "./p5-reauthorise";
import { attempt, gbp, issues, type Observation, type Probe, type ProbeContext } from "./probe";

/**
 * PayPal's Great Britain 3D Secure test card "Test Case 1: Successful
 * Frictionless Authentication" (developer.paypal.com/v5/expanded/3d-secure/test-scenarios,
 * read 12 October 2026), with a future expiry and a three-digit CVV as the
 * card-testing page asks.
 */
export const GB_TEST_CARD: TestCard = {
  number: "4462603042343024",
  expiry: "12/30",
  cvv: "123",
  name: "Pawhold Probe",
};

const BRANCH =
  "PayPal buttons (wallet) only for the demo; the owner's page says \"Pay with PayPal or a card through PayPal's checkout\" if the buttons' own card option works, and card fields are listed as unverified.";

/** Why a card hold could not be made: the page never reached the card, or PayPal refused. */
class CardHoldFailure extends Error {
  /**
   * @param reached - Whether the page reached a submit at all.
   * @param message - What happened.
   */
  constructor(
    readonly reached: boolean,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Makes a card hold: a GBP `AUTHORIZE` order, paid with the test card through
 * v6 card fields on the local page, then authorised.
 *
 * @param context - The run's context.
 * @param hold - The hold's name.
 * @param observations - Where the facts are recorded.
 * @returns The order as authorised and its authorisation.
 */
async function makeCardHold(
  context: ProbeContext,
  hold: string,
  observations: Record<string, Observation>,
) {
  const created = await createProbeOrder(context.client, {
    amount: gbp(10_000),
    referenceId: `probe-${hold}`,
    customId: `pawhold-probe-${hold}`,
    requestId: context.requestId(hold, "order.create"),
    payWith: "card",
  });
  context.holds.order(hold, created.id);
  const paid = await context.buyer.payByCard(created.id, GB_TEST_CARD);
  observations[`${hold}: eligible for advanced cards in GBP`] =
    paid.eligible ?? `unread: ${paid.eligibilityError ?? "no answer"}`;
  observations[`${hold}: submit state`] = paid.state;
  if (paid.state === null) {
    throw new CardHoldFailure(false, paid.error ?? "the card fields never submitted");
  }
  if (paid.state !== "succeeded") {
    throw new CardHoldFailure(
      true,
      `card fields submit answered ${paid.state}: ${JSON.stringify(paid.data)}`,
    );
  }
  const authorised = await attempt(() =>
    authorizeOrder(context.client, created.id, context.requestId(hold, "order.authorize")),
  );
  if (!authorised.ok) {
    throw new CardHoldFailure(
      true,
      `authorising the card-approved order was refused: ${authorised.error.name} (${issues(authorised.error)})`,
    );
  }
  const authorization = onlyAuthorization(authorised.value);
  context.holds.authorised(created.id, authorization.id);
  const card = authorised.value.payment_source?.card;
  observations[`${hold}: order`] = created.id;
  observations[`${hold}: authorisation`] = authorization.id;
  observations[`${hold}: authorisation status`] = authorization.status;
  observations[`${hold}: card`] = card
    ? `${card.brand ?? "?"} ${card.type ?? ""} ending ${card.last_digits ?? "?"}`.replace(
        /\s+/g,
        " ",
      )
    : null;
  observations[`${hold}: liability shift`] = card?.authentication_result?.liability_shift ?? null;
  return authorization;
}

/**
 * P6. Card fields authorise in GBP: a £100.00 `AUTHORIZE` order paid with a
 * GB test card through JS SDK v6 card fields on a page served locally; then
 * P2 and P3 repeated on card holds, and a card hold left standing for P5 (c).
 */
export const p6: Probe = {
  id: "P6",
  title: "Card fields authorise in GBP",
  question:
    "Does a GBP order with `intent: AUTHORIZE`, paid through JS SDK v6 card fields with a sandbox test card on a page served from localhost, authorise? Then P2 (capture £64.00 of £100.00, final) and P3 (£60.00 not final, then £30.00 final) repeated on card holds. Pass if all three card holds authorise and every capture is `COMPLETED`. Owed if the page cannot reach the card at all.",
  async run(context) {
    const observations: Record<string, Observation> = {};
    try {
      const less = await makeCardHold(context, "card.p2", observations);
      const captured = await captureAuthorization(context.client, less.id, {
        amount: gbp(6_400),
        finalCapture: true,
        requestId: context.requestId("card.p2", "capture"),
      });
      observations["card.p2: capture status"] = captured.status;
      observations["card.p2: captured (pence)"] = pence(captured.amount);
      observations["card.p2: authorisation status after"] = (
        await getAuthorization(context.client, less.id)
      ).status;

      const twice = await makeCardHold(context, "card.p3", observations);
      const first = await attempt(() =>
        captureAuthorization(context.client, twice.id, {
          amount: gbp(6_000),
          finalCapture: false,
          requestId: context.requestId("card.p3", "capture.1"),
        }),
      );
      observations["card.p3: first capture"] = first.ok ? first.value.status : issues(first.error);
      const second = first.ok
        ? await attempt(() =>
            captureAuthorization(context.client, twice.id, {
              amount: gbp(3_000),
              finalCapture: true,
              requestId: context.requestId("card.p3", "capture.2"),
            }),
          )
        : null;
      observations["card.p3: second capture"] =
        second === null ? null : second.ok ? second.value.status : issues(second.error);
      observations["card.p3: authorisation status after"] = (
        await getAuthorization(context.client, twice.id)
      ).status;

      const standing = await makeCardHold(context, "card.p5c", observations);
      context.holds.keep(standing.id, `P5 (c): reauthorise on or after ${P5_LATER_DATE}`);

      const pass =
        captured.status === "COMPLETED" &&
        first.ok &&
        first.value.status === "COMPLETED" &&
        second?.ok === true &&
        second.value.status === "COMPLETED";
      return {
        verdict: pass ? "pass" : "fail",
        summary: pass
          ? `Three GBP card holds authorised through v6 card fields; £64.00 of one captured as final, £60.00 then £30.00 of another, and ${standing.id} left standing for P5 (c).`
          : "The card holds authorised, but a capture was refused or did not complete; see the observations.",
        observations,
        branch: pass
          ? null
          : "P3's branch for card holds: U3 caps each card hold at a single final capture.",
      };
    } catch (error) {
      if (!(error instanceof CardHoldFailure)) {
        throw error;
      }
      observations["what happened"] = error.message;
      const firstHold = context.holds.entries.length <= 1;
      if (!error.reached && !firstHold) {
        throw new Error(
          `a later card hold did not reach the card after an earlier one authorised: ${error.message}`,
        );
      }
      return error.reached
        ? { verdict: "fail", summary: error.message, observations, branch: BRANCH }
        : {
            verdict: "owed",
            summary: `The local page did not reach a test card through v6 card fields: ${error.message}.`,
            observations,
            branch: null,
          };
    }
  },
};
