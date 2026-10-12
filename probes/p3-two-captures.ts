import type { PayPalError } from "@/paypal/client";

import { captureAuthorization, getAuthorization, pence } from "./paypal";
import { attempt, gbp, issues, makeWalletHold, type Observation, type Probe } from "./probe";

const BRANCH =
  "Look for the partial-capture switch on the sandbox business account (no REST API exposes account settings: the operator's dashboard to check) and ask in the PayPal Discord; meanwhile U3 caps each hold at a single final capture and the multi-capture path is dropped.";

/**
 * P3. Two captures against one hold: £60.00 not final, then £30.00 final.
 */
export const p3: Probe = {
  id: "P3",
  title: "Two captures against one hold",
  question:
    "Authorise £100.00 (wallet); capture £60.00 with `final_capture: false`, then £30.00 with `final_capture: true`. Pass if both are `COMPLETED`; fail if either is refused with a partial-capture error.",
  async run(context) {
    const hold = await makeWalletHold(context, "p3", gbp(10_000));
    const observations: Record<string, Observation> = {
      order: hold.orderId,
      authorization: hold.authorization.id,
    };
    const refused = (which: string, error: PayPalError) => ({
      verdict: "fail" as const,
      summary: `The ${which} capture against ${hold.authorization.id} was refused: ${error.name} (${issues(error)}).`,
      observations: {
        ...observations,
        [`${which} capture refused`]: issues(error),
        [`${which} capture debug id`]: error.debugId,
        [`${which} capture message`]: error.message,
      },
      branch: BRANCH,
    });

    const first = await attempt(() =>
      captureAuthorization(context.client, hold.authorization.id, {
        amount: gbp(6_000),
        finalCapture: false,
        requestId: context.requestId("p3", "capture.1"),
      }),
    );
    if (!first.ok) {
      return refused("first", first.error);
    }
    observations["first capture"] = first.value.id;
    observations["first capture status"] = first.value.status;
    observations["first captured (pence)"] = pence(first.value.amount);
    const between = await getAuthorization(context.client, hold.authorization.id);
    observations["authorisation status between"] = between.status;

    const second = await attempt(() =>
      captureAuthorization(context.client, hold.authorization.id, {
        amount: gbp(3_000),
        finalCapture: true,
        requestId: context.requestId("p3", "capture.2"),
      }),
    );
    if (!second.ok) {
      return refused("second", second.error);
    }
    observations["second capture"] = second.value.id;
    observations["second capture status"] = second.value.status;
    observations["second captured (pence)"] = pence(second.value.amount);
    const after = await getAuthorization(context.client, hold.authorization.id);
    observations["authorisation status after"] = after.status;

    const pass = first.value.status === "COMPLETED" && second.value.status === "COMPLETED";
    return {
      verdict: pass ? "pass" : "fail",
      summary: pass
        ? `Two captures against ${hold.authorization.id} completed: £60.00 not final (the authorisation then read ${between.status}) and £30.00 final (then ${after.status}).`
        : `The captures answered ${first.value.status} and ${second.value.status}.`,
      observations,
      branch: pass ? null : BRANCH,
    };
  },
};
