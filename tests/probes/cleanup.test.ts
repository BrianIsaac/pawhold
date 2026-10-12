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
  const served = replayFetch([token, ...exchanges], { strict: false });
  const client = createPayPalClient({
    clientId: "id",
    clientSecret: "secret",
    environment: "sandbox",
    fetch: served.fetch,
  });
  return { client, remaining: served.remaining };
}

/**
 * A ledger of orders O1, O2, ... authorised as the ids given.
 *
 * @param ids - The authorisations.
 * @returns The ledger.
 */
function ledger(ids: string[]): HoldLedger {
  const holds = new HoldLedger();
  ids.forEach((id, i) => {
    holds.order(`h${i}`, `O${i + 1}`);
    holds.authorised(`O${i + 1}`, id);
  });
  return holds;
}

describe("the clean-up check", () => {
  it("passes captured and voided authorisations and a kept hold still CREATED", async () => {
    const { client } = scripted([
      read("A1", "CAPTURED"),
      read("A2", "VOIDED"),
      read("A3", "CREATED"),
    ]);
    const holds = ledger(["A1", "A2", "A3"]);
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
    const holds = ledger(["A1", "A2"]);
    holds.keep("A2", "P5 (b)");

    const check = await checkClean(client, holds);

    expect(check.clean).toBe(false);
    expect(check.rows.map((r) => r.ok)).toEqual([false, false]);
  });

  it("refuses to keep an authorisation the run did not make", () => {
    expect(() => new HoldLedger().keep("ZZZ", "P5 (b)")).toThrow(/was not made by this run/);
  });

  it("finds an authorisation whose authorise call lost its answer, and passes an order never authorised", async () => {
    const { client, remaining } = scripted([
      answer("GET", "/v2/checkout/orders/O1", 200, {
        id: "O1",
        status: "COMPLETED",
        purchase_units: [{ payments: { authorizations: [{ id: "A1", status: "VOIDED" }] } }],
      }),
      read("A1", "VOIDED"),
      answer("GET", "/v2/checkout/orders/O2", 200, { id: "O2", status: "APPROVED" }),
    ]);
    const holds = new HoldLedger();
    holds.order("a", "O1");
    holds.order("b", "O2");

    const check = await checkClean(client, holds);

    expect(remaining()).toBe(0);
    expect(check.clean).toBe(true);
    expect(check.rows.map((r) => [r.orderId, r.authorizationId, r.status])).toEqual([
      ["O1", "A1", "VOIDED"],
      ["O2", null, "order APPROVED, not authorised"],
    ]);
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
      { holds: [], run: 1 },
      () => new Date("2026-10-12T11:00:00Z"),
    );
    for (const [i, id] of ["A1", "A2", "A3", "A4"].entries()) {
      context.holds.order(`h${i}`, `O${i + 1}`);
      context.holds.authorised(`O${i + 1}`, id);
    }
    context.holds.keep("A4", "P5 (b)");

    await releaseLeftovers(context);

    expect(remaining()).toBe(0);
    expect(notes.map((n) => n.text)).toEqual([
      "clean-up voided A1 (was CREATED)",
      "clean-up could not close A3: UNPROCESSABLE_ENTITY PREVIOUSLY_CAPTURED",
    ]);
  });
});

describe("the clean-up when PayPal fails part way", () => {
  it("goes on to the next hold and still checks every one, failing the check for what it could not read", async () => {
    const { client, remaining } = scripted([
      answer("GET", "/v2/payments/authorizations/A1", 404, { name: "RESOURCE_NOT_FOUND" }),
      read("A2", "CREATED"),
      answer("POST", "/v2/payments/authorizations/A2/void", 200, { id: "A2", status: "VOIDED" }),
      answer("GET", "/v2/payments/authorizations/A1", 404, { name: "RESOURCE_NOT_FOUND" }),
      read("A2", "VOIDED"),
    ]);
    const { context, notes } = createContext(
      client,
      replayBuyer([]),
      { holds: [], run: 1 },
      () => new Date("2026-10-12T11:00:00Z"),
    );
    for (const [i, id] of ["A1", "A2"].entries()) {
      context.holds.order(`h${i}`, `O${i + 1}`);
      context.holds.authorised(`O${i + 1}`, id);
    }

    await releaseLeftovers(context);
    const check = await checkClean(client, context.holds);

    expect(remaining()).toBe(0);
    expect(notes.map((n) => n.text)).toEqual([
      "clean-up could not close A1: RESOURCE_NOT_FOUND",
      "clean-up voided A2 (was CREATED)",
    ]);
    expect(check.clean).toBe(false);
    expect(check.rows.map((r) => [r.authorizationId, r.status, r.ok])).toEqual([
      ["A1", "unread: RESOURCE_NOT_FOUND", false],
      ["A2", "VOIDED", true],
    ]);
  });
});
