import { describe, expect, it } from "vitest";

import { createPayPalClient } from "@/paypal/client";

import { checkClean, createContext, HoldLedger, releaseLeftovers } from "../../probes/probe";
import type { Exchange } from "../../probes/recorder";
import { replayBuyer, replayFetch } from "../../probes/replay";

const token: Exchange = {
  at: "2026-10-12T11:00:00.000Z",
  ms: 1,
  method: "POST",
  path: "/v1/oauth2/token",
  requestId: null,
  sentHeaders: {},
  requestBody: null,
  status: 200,
  debugId: null,
  responseBody: null,
};

const answer = (method: string, path: string, status: number, body: unknown): Exchange => ({
  ...token,
  method,
  path,
  status,
  responseBody: body,
});

const read = (id: string, status: string) =>
  answer("GET", `/v2/payments/authorizations/${id}`, 200, { id, status });

/**
 * A client over a script of PayPal's answers.
 *
 * @param exchanges - The answers, in order, after the token.
 * @returns The client and what is left unserved.
 */
function scripted(exchanges: Exchange[]) {
  const served = replayFetch([token, ...exchanges]);
  const client = createPayPalClient({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    fetch: served.fetch,
  });
  return { client, remaining: served.remaining };
}

describe("the clean-up check", () => {
  it("passes captured and voided authorisations and a kept hold still CREATED", async () => {
    const { client } = scripted([
      read("A1", "CAPTURED"),
      read("A2", "VOIDED"),
      read("A3", "CREATED"),
    ]);
    const holds = new HoldLedger();
    holds.add({ hold: "a", orderId: "O1", authorizationId: "A1" });
    holds.add({ hold: "b", orderId: "O2", authorizationId: "A2" });
    holds.add({ hold: "c", orderId: "O3", authorizationId: "A3" });
    holds.keep("A3", "P5 (b) on or after 17 October 2026");

    const check = await checkClean(client, holds);

    expect(check.clean).toBe(true);
    expect(check.rows.map((r) => [r.authorizationId, r.status, r.ok])).toEqual([
      ["A1", "CAPTURED", true],
      ["A2", "VOIDED", true],
      ["A3", "CREATED", true],
    ]);
  });

  it("fails an authorisation still open, and a kept hold that was captured", async () => {
    const { client } = scripted([read("A1", "PARTIALLY_CAPTURED"), read("A2", "CAPTURED")]);
    const holds = new HoldLedger();
    holds.add({ hold: "a", orderId: "O1", authorizationId: "A1" });
    holds.add({ hold: "b", orderId: "O2", authorizationId: "A2" });
    holds.keep("A2", "P5 (b)");

    const check = await checkClean(client, holds);

    expect(check.clean).toBe(false);
    expect(check.rows.map((r) => r.ok)).toEqual([false, false]);
  });

  it("refuses to keep an authorisation the run did not make", () => {
    expect(() => new HoldLedger().keep("ZZZ", "P5 (b)")).toThrow(/was not made by this run/);
  });
});

describe("the clean-up of a run that ended early", () => {
  it("voids what is still open, skips what is closed or kept, and notes a refused void", async () => {
    const { client, remaining } = scripted([
      read("A1", "CREATED"),
      answer("POST", "/v2/payments/authorizations/A1/void", 200, { id: "A1", status: "VOIDED" }),
      read("A2", "CAPTURED"),
      read("A3", "PARTIALLY_CAPTURED"),
      answer("POST", "/v2/payments/authorizations/A3/void", 422, {
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: "PREVIOUSLY_CAPTURED" }],
      }),
    ]);
    const { context, notes } = createContext(
      client,
      replayBuyer([]),
      { holds: [] },
      () => new Date("2026-10-12T11:00:00Z"),
    );
    context.holds.add({ hold: "a", orderId: "O1", authorizationId: "A1" });
    context.holds.add({ hold: "b", orderId: "O2", authorizationId: "A2" });
    context.holds.add({ hold: "c", orderId: "O3", authorizationId: "A3" });
    context.holds.add({ hold: "d", orderId: "O4", authorizationId: "A4" });
    context.holds.keep("A4", "P5 (b)");

    await releaseLeftovers(context);

    expect(remaining()).toBe(0);
    expect(notes.map((n) => n.text)).toEqual([
      "clean-up voided A1 (was CREATED)",
      "clean-up could not void A3: UNPROCESSABLE_ENTITY PREVIOUSLY_CAPTURED",
    ]);
  });
});
