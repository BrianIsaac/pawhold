import { describe, expect, it } from "vitest";

import { MoneyError } from "@/money/errors";
import { reauthorisationDetail, voidTarget } from "@/money/holds";
import { paypalRequestId } from "@/paypal/request-id";

const CASE = "6f1d6b0e-2a43-4b8e-9a51-0c6e1f4a7b21";
const HOLD = "0b9c2f6e-8d4a-4e1b-b7c3-5a2e9d1f6c80";

describe("the authorisation a void of an authorised hold goes against (PayPal's CANNOT_BE_VOIDED)", () => {
  it("voids a hold never reauthorised by its own authorisation, under the step's request id", () => {
    const target = voidTarget(
      { id: HOLD, caseId: CASE, authorizationId: "AUTH", originalAuthorizationId: "AUTH" },
      "void",
    );

    expect(target).toEqual({
      authorizationId: "AUTH",
      reauthorizationId: null,
      requestId: paypalRequestId({ caseId: CASE, holdId: HOLD, step: "void" }),
    });
    expect(reauthorisationDetail(target)).toEqual({});
  });

  it("voids a reauthorised hold by its original parent, never the reauthorisation, under a request id of its own", () => {
    const target = voidTarget(
      { id: HOLD, caseId: CASE, authorizationId: "REAUTH", originalAuthorizationId: "PARENT" },
      "void.session_end",
    );

    expect(target).toEqual({
      authorizationId: "PARENT",
      reauthorizationId: "REAUTH",
      requestId: paypalRequestId({ caseId: CASE, holdId: HOLD, step: "void.session_end.parent" }),
    });
    expect(target.requestId).not.toBe(
      paypalRequestId({ caseId: CASE, holdId: HOLD, step: "void.session_end" }),
    );
    expect(reauthorisationDetail(target)).toEqual({ reauthorizationId: "REAUTH" });
  });

  it("refuses a hold that holds no authorisation", () => {
    expect(() =>
      voidTarget(
        { id: HOLD, caseId: CASE, authorizationId: null, originalAuthorizationId: null },
        "void",
      ),
    ).toThrow(MoneyError);
  });
});
