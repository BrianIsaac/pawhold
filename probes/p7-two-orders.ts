import type { PayPalError } from "@/paypal/client";

import { captureAuthorization, getAuthorization, voidAuthorization } from "./paypal";
import { attempt, gbp, issues, makeWalletHold, type Observation, type Probe } from "./probe";

const BRANCH =
  "Each update replaces the hold instead: void the first hold and authorise a new order for the whole revised estimate (one hold per case at a time); the owner's page says the earlier hold is released.";

/**
 * P7. Two orders, one buyer, one case: an update's order authorised while
 * the estimate's hold stands; the first captured in full, the second in part
 * and the rest of it voided.
 */
export const p7: Probe = {
  id: "P7",
  title: "Two orders, one buyer, one case",
  question:
    "With a £100.00 hold standing, can the same buyer approve and authorise a second order (£50.00, the update)? Then capture the first in full, capture £20.00 of the second not final and void its rest. Pass if the second authorisation is made while the first is held and every step succeeds.",
  async run(context) {
    const first = await makeWalletHold(context, "estimate", gbp(10_000));
    const observations: Record<string, Observation> = {
      "first order": first.orderId,
      "first authorisation": first.authorization.id,
    };
    const failed = (step: string, error: PayPalError) => ({
      verdict: "fail" as const,
      summary: `${step} was refused: ${error.name} (${issues(error)}).`,
      observations: {
        ...observations,
        [`${step} refused`]: issues(error),
        "debug id": error.debugId,
      },
      branch: BRANCH,
    });

    const second = await attempt(() => makeWalletHold(context, "update", gbp(5_000)));
    if (!second.ok) {
      return failed("the second authorisation", second.error);
    }
    const firstWhileSecond = await getAuthorization(context.client, first.authorization.id);
    observations["second order"] = second.value.orderId;
    observations["second authorisation"] = second.value.authorization.id;
    observations["second authorisation status"] = second.value.authorization.status;
    observations["first authorisation status once the second was made"] = firstWhileSecond.status;

    const fullCapture = await attempt(() =>
      captureAuthorization(context.client, first.authorization.id, {
        finalCapture: true,
        requestId: context.requestId("estimate", "capture"),
      }),
    );
    if (!fullCapture.ok) {
      return failed("the first hold's capture", fullCapture.error);
    }
    observations["first capture"] = fullCapture.value.id;
    observations["first capture status"] = fullCapture.value.status;

    const partCapture = await attempt(() =>
      captureAuthorization(context.client, second.value.authorization.id, {
        amount: gbp(2_000),
        finalCapture: false,
        requestId: context.requestId("update", "capture"),
      }),
    );
    if (!partCapture.ok) {
      return failed("the second hold's part capture", partCapture.error);
    }
    observations["second capture"] = partCapture.value.id;
    observations["second capture status"] = partCapture.value.status;

    const voided = await attempt(() =>
      voidAuthorization(
        context.client,
        second.value.authorization.id,
        context.requestId("update", "void"),
      ),
    );
    if (!voided.ok) {
      return failed("the second hold's void", voided.error);
    }
    const firstAfter = await getAuthorization(context.client, first.authorization.id);
    const secondAfter = await getAuthorization(context.client, second.value.authorization.id);
    observations["first authorisation status after"] = firstAfter.status;
    observations["second authorisation status after"] = secondAfter.status;

    const pass =
      second.value.authorization.status === "CREATED" &&
      firstWhileSecond.status === "CREATED" &&
      fullCapture.value.status === "COMPLETED" &&
      partCapture.value.status === "COMPLETED" &&
      firstAfter.status === "CAPTURED" &&
      secondAfter.status === "VOIDED";
    return {
      verdict: pass ? "pass" : "fail",
      summary: pass
        ? `The buyer authorised a second order (${second.value.authorization.id}) while the first hold stood; the first was captured in full, £20.00 of the second captured and its rest voided.`
        : "The two holds did not close as designed; see the observations.",
      observations,
      branch: pass ? null : BRANCH,
    };
  },
};
