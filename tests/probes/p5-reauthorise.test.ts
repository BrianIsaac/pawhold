import { describe, expect, it } from "vitest";

import { PROBES } from "../../probes/index";
import { honourPeriodEnds } from "../../probes/p5-reauthorise";
import type { Probe } from "../../probes/probe";
import type { Exchange } from "../../probes/recorder";
import { replay } from "../../probes/replay";
import type { ProbeRun } from "../../probes/run-once";

import { replayRecorded } from "./support";

describe("P5 (a), over the sandbox's recorded answers", () => {
  it("is refused REAUTHORIZATION_TOO_SOON, keeps the hold standing, and gets AUTHORIZATION_EXPIRED by negative testing", async () => {
    const { replayed } = await replayRecorded("P5A");

    expect(replayed.outcome).toMatchObject({
      verdict: "pass",
      observations: {
        "reauthorisation refused, HTTP": 422,
        "reauthorisation refused, issue": "REAUTHORIZATION_TOO_SOON",
        "kept authorisation status after the attempt": "CREATED",
        "negative test, HTTP": 422,
        "negative test, issue": "AUTHORIZATION_EXPIRED",
      },
    });
    const kept = replayed.cleanup?.rows.filter((r) => r.kept !== null) ?? [];
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ status: "CREATED", ok: true });
    expect(replayed.cleanup?.clean).toBe(true);
  });

  it("dates the end of the honour period three days from the authorisation", () => {
    expect(honourPeriodEnds("2026-10-12T11:33:30Z")).toBe("2026-10-15T11:33:30.000Z");
    expect(honourPeriodEnds(undefined)).toBeNull();
  });
});

const exchange = (method: string, path: string, status: number, body: unknown): Exchange => ({
  at: "2026-10-17T09:00:00.000Z",
  ms: 1,
  method,
  path,
  requestId: null,
  sentHeaders: {},
  requestBody: null,
  status,
  debugId: null,
  responseBody: body,
});

const TOKEN = exchange("POST", "/v1/oauth2/token", 200, null);
const STANDING = {
  id: "STANDING1",
  status: "CREATED",
  create_time: "2026-10-12T11:33:30Z",
  links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/checkout/orders/ORDER1" }],
};

/**
 * A scripted run of a later part of P5, dated as given.
 *
 * @param probe - P5B or P5C.
 * @param at - When the run happens.
 * @param exchanges - PayPal's answers, after the token.
 * @returns The replayed run and what went unserved.
 */
async function scripted(probe: Probe, at: string, exchanges: Exchange[]) {
  const recorded: ProbeRun = {
    probe: probe.id,
    startedAt: at,
    endedAt: at,
    options: { holds: ["STANDING1", "STANDING2"], run: 1 },
    outcome: null,
    error: null,
    exchanges: exchanges.length > 0 ? [TOKEN, ...exchanges] : [],
    buyer: [],
    notes: [],
    cleanup: null,
  };
  return replay(probe, recorded, { strict: false });
}

const p5b = PROBES.get("P5B")!;
const p5c = PROBES.get("P5C")!;

describe("P5 (b) and (c) before 17 October", () => {
  it.each([p5b, p5c])("$id is owed and calls PayPal not at all", async (probe) => {
    const { run, unserved } = await scripted(probe, "2026-10-16T23:59:59.000Z", []);

    expect(unserved).toBe(0);
    expect(run.exchanges).toEqual([]);
    expect(run.outcome).toMatchObject({
      verdict: "owed",
      observations: { "run on or after": "2026-10-17" },
    });
  });
});

describe("P5 (b) on 17 October, over scripted answers in PayPal's documented shapes", () => {
  it("passes when the standing hold reauthorises with a new id and the new id captures", async () => {
    const { run, unserved } = await scripted(p5b, "2026-10-17T09:00:00.000Z", [
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, STANDING),
      exchange("POST", "/v2/payments/authorizations/STANDING1/reauthorize", 201, {
        id: "NEW1",
        status: "CREATED",
        expiration_time: "2026-11-10T11:33:30Z",
      }),
      exchange("POST", "/v2/payments/authorizations/NEW1/capture", 201, {
        id: "CAP1",
        status: "COMPLETED",
        amount: { currency_code: "GBP", value: "100.00" },
      }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, {
        id: "STANDING1",
        status: "CAPTURED",
      }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, {
        id: "STANDING1",
        status: "CAPTURED",
      }),
      exchange("GET", "/v2/payments/authorizations/NEW1", 200, { id: "NEW1", status: "CAPTURED" }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, {
        id: "STANDING1",
        status: "CAPTURED",
      }),
      exchange("GET", "/v2/payments/authorizations/NEW1", 200, { id: "NEW1", status: "CAPTURED" }),
    ]);

    expect(run.error).toBeNull();
    expect(unserved).toBe(0);
    expect(run.outcome).toMatchObject({
      verdict: "pass",
      observations: {
        "new authorisation": "NEW1",
        "capture status": "COMPLETED",
        "captured (pence)": 10_000,
      },
    });
    expect(run.cleanup?.clean).toBe(true);
  });

  it("fails with the plan's branch when the reauthorisation is refused, and voids the standing hold", async () => {
    const { run, unserved } = await scripted(p5b, "2026-10-17T09:00:00.000Z", [
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, STANDING),
      exchange("POST", "/v2/payments/authorizations/STANDING1/reauthorize", 422, {
        name: "UNPROCESSABLE_ENTITY",
        debug_id: "dbg",
        details: [{ issue: "REAUTHORIZATION_TOO_SOON" }],
      }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, STANDING),
      exchange("POST", "/v2/payments/authorizations/STANDING1/void", 200, {
        id: "STANDING1",
        status: "VOIDED",
      }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, {
        id: "STANDING1",
        status: "VOIDED",
      }),
    ]);

    expect(unserved).toBe(0);
    expect(run.outcome?.verdict).toBe("fail");
    expect(run.outcome?.branch).toMatch(/turned off in judge mode/);
    expect(run.cleanup?.clean).toBe(true);
  });
});

describe("P5 (c) on 17 October, over scripted answers", () => {
  it("passes when the card hold's reauthorisation is refused", async () => {
    const { run, unserved } = await scripted(p5c, "2026-10-17T09:00:00.000Z", [
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, STANDING),
      exchange("POST", "/v2/payments/authorizations/STANDING1/reauthorize", 422, {
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: "REAUTHORIZATION_NOT_SUPPORTED" }],
      }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, STANDING),
      exchange("POST", "/v2/payments/authorizations/STANDING1/void", 200, {
        id: "STANDING1",
        status: "VOIDED",
      }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, {
        id: "STANDING1",
        status: "VOIDED",
      }),
    ]);

    expect(unserved).toBe(0);
    expect(run.outcome).toMatchObject({
      verdict: "pass",
      observations: { "reauthorisation refused, issue": "REAUTHORIZATION_NOT_SUPPORTED" },
    });
  });
});

describe("P5's refusals that are not PayPal's answer on the merits", () => {
  it("breaks the run, with no verdict, when PayPal answers 503 to the reauthorisation", async () => {
    const { run } = await scripted(p5c, "2026-10-17T09:00:00.000Z", [
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, STANDING),
      exchange("POST", "/v2/payments/authorizations/STANDING1/reauthorize", 503, {
        name: "SERVICE_UNAVAILABLE",
      }),
      exchange("POST", "/v2/payments/authorizations/STANDING1/reauthorize", 503, {
        name: "SERVICE_UNAVAILABLE",
      }),
      exchange("POST", "/v2/payments/authorizations/STANDING1/reauthorize", 503, {
        name: "SERVICE_UNAVAILABLE",
      }),
      exchange("POST", "/v2/payments/authorizations/STANDING1/reauthorize", 503, {
        name: "SERVICE_UNAVAILABLE",
      }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, STANDING),
      exchange("POST", "/v2/payments/authorizations/STANDING1/void", 200, {
        id: "STANDING1",
        status: "VOIDED",
      }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, {
        id: "STANDING1",
        status: "VOIDED",
      }),
    ]);

    expect(run.outcome).toBeNull();
    expect(run.error).toMatch(/SERVICE_UNAVAILABLE/);
  });

  it("breaks the run when the standing hold is no longer CREATED", async () => {
    const { run } = await scripted(p5c, "2026-10-17T09:00:00.000Z", [
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, {
        ...STANDING,
        status: "VOIDED",
      }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, {
        ...STANDING,
        status: "VOIDED",
      }),
      exchange("GET", "/v2/payments/authorizations/STANDING1", 200, {
        ...STANDING,
        status: "VOIDED",
      }),
    ]);

    expect(run.outcome).toBeNull();
    expect(run.error).toMatch(/reads VOIDED, not CREATED/);
  });
});
