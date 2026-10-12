import {
  captureAuthorization,
  getAuthorization,
  getCapture,
  pence,
  voidAuthorization,
} from "./paypal";
import { attempt, gbp, issues, makeWalletHold, type Probe } from "./probe";

const BRANCH =
  "Discharge closes each hold with its last capture marked `final_capture: true` and voids only holds that took no capture at all; the receipt's released line is computed, and the audit trail records which way each hold closed.";

/**
 * P4. Void after a partial capture: £60.00 of £100.00 captured not final,
 * then the rest voided. Whether `PAYMENT.AUTHORIZATION.VOIDED` arrives is
 * P8's (no listener yet).
 */
export const p4: Probe = {
  id: "P4",
  title: "Void after a partial capture",
  question:
    "Authorise £100.00; capture £60.00 with `final_capture: false`; void. Pass if the void answers success, the authorisation reads `VOIDED` and the £60.00 capture stands `COMPLETED`. (The `PAYMENT.AUTHORIZATION.VOIDED` delivery is read in P8.)",
  async run(context) {
    const hold = await makeWalletHold(context, "p4", gbp(10_000));
    const capture = await captureAuthorization(context.client, hold.authorization.id, {
      amount: gbp(6_000),
      finalCapture: false,
      requestId: context.requestId("p4", "capture"),
    });
    const between = await getAuthorization(context.client, hold.authorization.id);
    const voided = await attempt(() =>
      voidAuthorization(context.client, hold.authorization.id, context.requestId("p4", "void")),
    );
    const base = {
      order: hold.orderId,
      authorization: hold.authorization.id,
      capture: capture.id,
      "capture status": capture.status,
      "authorisation status between": between.status,
    };
    if (!voided.ok) {
      return {
        verdict: "fail",
        summary: `The void of ${hold.authorization.id} after a £60.00 capture was refused: ${voided.error.name} (${issues(voided.error)}).`,
        observations: {
          ...base,
          "void refused": issues(voided.error),
          "void debug id": voided.error.debugId,
        },
        branch: BRANCH,
      };
    }
    const after = await getAuthorization(context.client, hold.authorization.id);
    const captureAfter = await getCapture(context.client, capture.id);
    const pass = after.status === "VOIDED" && captureAfter.status === "COMPLETED";
    return {
      verdict: pass ? "pass" : "fail",
      summary: pass
        ? `After £60.00 was captured not final, the void of ${hold.authorization.id} succeeded; it reads VOIDED and the capture stands COMPLETED.`
        : `The void answered, but the authorisation reads ${after.status} and the capture ${captureAfter.status}.`,
      observations: {
        ...base,
        "void answered": voided.value === null ? "no content" : voided.value.status,
        "authorisation status after": after.status,
        "authorisation amount after (pence)": pence(after.amount),
        "capture status after": captureAfter.status,
        "captured (pence)": pence(captureAfter.amount),
      },
      branch: pass ? null : BRANCH,
    };
  },
};
