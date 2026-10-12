import { describe, expect, it } from "vitest";

import { type Exchange, recordingFetch } from "../../probes/recorder";

/**
 * A fetch answering every request with one canned response.
 *
 * @param status - The status.
 * @param body - The JSON body, or null for none.
 * @param debugId - The `Paypal-Debug-Id` header.
 * @returns The fetch.
 */
function answering(status: number, body: unknown, debugId?: string): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: debugId ? { "paypal-debug-id": debugId } : {},
      }),
    );
}

const at = () => Date.UTC(2026, 9, 12, 11, 0, 0);

describe("the probes' recording fetch", () => {
  it("records a call's time, request id, kept headers, bodies (redacted), status and debug id", async () => {
    const log: Exchange[] = [];
    const recorded = recordingFetch(
      answering(
        201,
        { id: "C1", status: "COMPLETED", payer: { email_address: "b@x.com" } },
        "dbg1",
      ),
      log,
      at,
    );

    const answer = await recorded(
      "https://api-m.sandbox.paypal.com/v2/payments/authorizations/A1/capture",
      {
        method: "POST",
        headers: {
          authorization: "Bearer SECRET-TOKEN",
          "paypal-request-id": "rid-1",
          prefer: "return=representation",
        },
        body: JSON.stringify({ final_capture: true }),
      },
    );

    expect(await answer.json()).toMatchObject({ id: "C1" });
    expect(log).toEqual([
      {
        at: "2026-10-12T11:00:00.000Z",
        ms: 0,
        method: "POST",
        path: "/v2/payments/authorizations/A1/capture",
        requestId: "rid-1",
        sentHeaders: { prefer: "return=representation" },
        requestBody: { final_capture: true },
        status: 201,
        debugId: "dbg1",
        responseBody: { id: "C1", status: "COMPLETED", payer: { email_address: "<redacted>" } },
      },
    ]);
    expect(JSON.stringify(log)).not.toContain("SECRET-TOKEN");
  });

  it("keeps neither the token call's form body nor its answer", async () => {
    const log: Exchange[] = [];
    await recordingFetch(
      answering(200, { access_token: "A21AA-REAL" }, "dbg2"),
      log,
      at,
    )("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
      method: "POST",
      body: "grant_type=client_credentials",
    });

    expect(log[0]).toMatchObject({
      status: 200,
      debugId: "dbg2",
      requestBody: null,
      responseBody: null,
    });
    expect(JSON.stringify(log)).not.toContain("A21AA-REAL");
  });

  it("takes the debug id from an error body when the header is absent, and records an empty answer", async () => {
    const log: Exchange[] = [];
    await recordingFetch(
      answering(422, { name: "UNPROCESSABLE_ENTITY", debug_id: "dbg3" }),
      log,
      at,
    )("https://api-m.sandbox.paypal.com/v2/payments/authorizations/A1/void", { method: "POST" });
    await recordingFetch(
      answering(204, null),
      log,
      at,
    )("https://api-m.sandbox.paypal.com/v2/payments/authorizations/A2/void", { method: "POST" });

    expect(log.map((x) => [x.status, x.debugId, x.responseBody])).toEqual([
      [422, "dbg3", { name: "UNPROCESSABLE_ENTITY", debug_id: "dbg3" }],
      [204, null, null],
    ]);
  });

  it("records a request that got no answer, and rethrows", async () => {
    const log: Exchange[] = [];
    const failing: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));

    await expect(
      recordingFetch(
        failing,
        log,
        at,
      )("https://api-m.sandbox.paypal.com/v2/checkout/orders", {
        method: "POST",
      }),
    ).rejects.toThrow("fetch failed");
    expect(log[0]).toMatchObject({ status: null, path: "/v2/checkout/orders" });
  });
});
