import { captureAuthorization, getAuthorization, pence } from "./paypal";
import { attempt, gbp, issues, makeWalletHold, type Probe } from "./probe";

/**
 * P2. Capture less than held: £64.00 of a £100.00 wallet hold, as the final
 * capture.
 */
export const p2: Probe = {
  id: "P2",
  title: "Capture less than held",
  question:
    "Authorise £100.00 (wallet), capture £64.00 with `final_capture: true`. Pass if the capture is `COMPLETED`; the authorisation's status is read back and recorded as PayPal states it (expected `CAPTURED` or `PARTIALLY_CAPTURED`).",
  async run(context) {
    const hold = await makeWalletHold(context, "p2", gbp(10_000));
    const captured = await attempt(() =>
      captureAuthorization(context.client, hold.authorization.id, {
        amount: gbp(6_400),
        finalCapture: true,
        requestId: context.requestId("p2", "capture"),
      }),
    );
    if (!captured.ok) {
      return {
        verdict: "fail",
        summary: `PayPal refused to capture £64.00 of the £100.00 hold ${hold.authorization.id}: ${captured.error.name} (${issues(captured.error)}).`,
        observations: {
          authorization: hold.authorization.id,
          "capture refused": issues(captured.error),
          "debug id": captured.error.debugId,
        },
        branch: "The core flow cannot run as designed: stop and re-plan before U3.",
      };
    }
    const capture = captured.value;
    const after = await getAuthorization(context.client, hold.authorization.id);
    const breakdown = capture.seller_receivable_breakdown;
    const pass = capture.status === "COMPLETED" && pence(capture.amount) === 6_400;
    return {
      verdict: pass ? "pass" : "fail",
      summary: pass
        ? `Capture ${capture.id} took £64.00 of the £100.00 hold as final; the authorisation reads ${after.status}.`
        : `Capture ${capture.id} answered ${capture.status} for ${capture.amount?.value ?? "?"}.`,
      observations: {
        order: hold.orderId,
        authorization: hold.authorization.id,
        capture: capture.id,
        "capture status": capture.status,
        "capture status reason": capture.status_details?.reason ?? null,
        "captured (pence)": pence(capture.amount),
        "final_capture echoed": capture.final_capture ?? null,
        "PayPal fee (pence)": pence(breakdown?.paypal_fee),
        "net (pence)": pence(breakdown?.net_amount),
        "fee currency": breakdown?.paypal_fee?.currency_code ?? null,
        "authorisation status after": after.status,
        "authorisation status reason": after.status_details?.reason ?? null,
      },
      branch: pass ? null : "The core flow cannot run as designed: stop and re-plan before U3.",
    };
  },
};
