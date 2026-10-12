import { describe, expect, it } from "vitest";

import {
  createP8,
  cyclesOutOfOrder,
  type Expectation,
  matchArrivals,
  percentile95,
  type StoredDelivery,
  type WebhookStore,
} from "../../probes/p8-webhooks";
import type { ProbeRun } from "../../probes/run-once";
import { replay } from "../../probes/replay";

const expectation = (cycle: number, type: string, id: string, at: string): Expectation => ({
  cycle,
  eventTypes: [type],
  resourceId: id,
  answeredAt: at,
});

const delivery = (type: string, id: string, at: string): StoredDelivery => ({
  eventId: `WH-${type}-${id}`,
  eventType: type,
  resourceId: id,
  verification: "signature",
  isMock: false,
  receivedAt: at,
  rawBody: "{}",
  transmissionId: "t",
  transmissionTime: at,
  certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  authAlgo: "SHA256withRSA",
  transmissionSig: "sig",
});

describe("P8's arithmetic", () => {
  it("pairs each expected event with its delivery and takes the lag from PayPal's API answer", () => {
    const arrivals = matchArrivals(
      [
        expectation(1, "PAYMENT.AUTHORIZATION.CREATED", "A1", "2026-10-14T10:00:00.000Z"),
        expectation(1, "PAYMENT.AUTHORIZATION.VOIDED", "A1", "2026-10-14T10:00:05.000Z"),
        expectation(1, "PAYMENT.CAPTURE.COMPLETED", "C1", "2026-10-14T10:00:03.000Z"),
      ],
      [
        delivery("PAYMENT.AUTHORIZATION.VOIDED", "A1", "2026-10-14T10:00:07.500Z"),
        delivery("PAYMENT.AUTHORIZATION.CREATED", "A1", "2026-10-14T10:00:02.000Z"),
        delivery("PAYMENT.AUTHORIZATION.CREATED", "A1", "2026-10-14T10:01:00.000Z"),
      ],
    );

    expect(arrivals.map((a) => a.lagSeconds)).toEqual([2, 2.5, null]);
    expect(arrivals[0]!.delivery?.receivedAt).toBe("2026-10-14T10:00:02.000Z");
  });

  it("takes the 95th percentile by nearest rank, a missing event counting as unbounded", () => {
    expect(percentile95([])).toBeNull();
    expect(percentile95(Array.from({ length: 40 }, (_, i) => i + 1))).toBe(38);
    expect(percentile95([1, 2, null])).toBe(Number.POSITIVE_INFINITY);
  });

  it("counts the cycles whose events were stored out of the steps' order", () => {
    const arrivals = matchArrivals(
      [
        expectation(1, "E1", "X1", "2026-10-14T10:00:00Z"),
        expectation(1, "E2", "X2", "2026-10-14T10:00:01Z"),
        expectation(2, "E1", "Y1", "2026-10-14T10:00:02Z"),
        expectation(2, "E2", "Y2", "2026-10-14T10:00:03Z"),
      ],
      [
        delivery("E1", "X1", "2026-10-14T10:00:02Z"),
        delivery("E2", "X2", "2026-10-14T10:00:03Z"),
        delivery("E1", "Y1", "2026-10-14T10:00:09Z"),
        delivery("E2", "Y2", "2026-10-14T10:00:04Z"),
      ],
    );

    expect(cyclesOutOfOrder(arrivals)).toBe(1);
  });
});

/**
 * Runs P8 with the setup given and no PayPal answers to serve.
 *
 * @param setup - The webhook id, store URL and store.
 * @returns The run.
 */
async function runP8(setup: Parameters<typeof createP8>[0]) {
  const recorded: ProbeRun = {
    probe: "P8",
    startedAt: "2026-10-12T12:00:00.000Z",
    endedAt: "2026-10-12T12:00:00.000Z",
    options: { holds: [], run: 1 },
    outcome: null,
    error: null,
    exchanges: [],
    buyer: [],
    notes: [],
    cleanup: null,
  };
  return replay(createP8(setup), recorded, { strict: false });
}

describe("P8 before the listener is deployed", () => {
  it("is owed, names what is missing and calls PayPal not at all", async () => {
    const { run } = await runP8({
      webhookId: undefined,
      storeUrl: undefined,
      openStore: () => {
        throw new Error("no store to open");
      },
    });

    expect(run.exchanges).toEqual([]);
    expect(run.outcome?.verdict).toBe("owed");
    expect(run.outcome?.summary).toContain("PAYPAL_WEBHOOK_ID");
    expect(run.outcome?.summary).toContain("P8_DATABASE_URL");
  });

  it("is owed while the listener keeps no transmission_sig, and closes the store", async () => {
    let closed = false;
    const store: WebhookStore = {
      keepsSignatures: () => Promise.resolve(false),
      find: () => Promise.resolve([]),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };

    const { run } = await runP8({
      webhookId: "WH1",
      storeUrl: "postgres://x",
      openStore: () => store,
    });

    expect(run.exchanges).toEqual([]);
    expect(run.outcome?.verdict).toBe("owed");
    expect(run.outcome?.summary).toContain("keeps no transmission_sig");
    expect(run.outcome?.summary).toContain("migration 0005");
    expect(run.outcome?.summary).not.toContain("Owed to the day U1's listener is deployed");
    expect(closed).toBe(true);
  });
});
