import { readFileSync, writeFileSync } from "node:fs";

import type { ActivityReading, Approval, Buyer, BuyerSession, CardPayment } from "./buyer";
import type { Probe } from "./probe";
import type { Exchange } from "./recorder";
import { type BuyerEvent, type ProbeRun, runOnce } from "./run-once";

/*
 * A probe's run, recorded, and replayed: the replay serves PayPal's recorded
 * answers in the order they came and the buyer's recorded steps, so the
 * probe's logic and its verdict are tested without the sandbox.
 */

const RECORDED = new URL("./recorded/", import.meta.url);

/**
 * The file a probe's recording lives in.
 *
 * @param probe - The probe's id.
 * @returns The file's URL.
 */
export function recordingFile(probe: string): URL {
  return new URL(`${probe}.json`, RECORDED);
}

/**
 * Writes a run as its probe's recording.
 *
 * @param run - The run.
 * @param text - The run as JSON, already checked for secrets.
 */
export function writeRecording(run: ProbeRun, text: string): void {
  writeFileSync(recordingFile(run.probe), text);
}

/**
 * Reads a probe's recording.
 *
 * @param probe - The probe's id.
 * @returns The recorded run.
 */
export function readRecording(probe: string): ProbeRun {
  return JSON.parse(readFileSync(recordingFile(probe), "utf8")) as ProbeRun;
}

/** A replay's fetch, and what it has not yet served. */
export interface ReplayFetch {
  readonly fetch: typeof fetch;
  readonly remaining: () => number;
}

/**
 * A fetch that answers with a run's recorded exchanges, in order, refusing a
 * request that is not the next one recorded.
 *
 * @param exchanges - The recorded exchanges.
 * @returns The fetch.
 */
export function replayFetch(exchanges: readonly Exchange[]): ReplayFetch {
  const queue = [...exchanges];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = `${url.pathname}${url.search}`;
    const next = queue.shift();
    if (!next || next.method !== method || next.path !== path) {
      throw new Error(
        `replay: ${method} ${path} was not the next request recorded (${next ? `${next.method} ${next.path}` : "none left"})`,
      );
    }
    if (next.status === null) {
      return Promise.reject(new TypeError("fetch failed (recorded)"));
    }
    const body =
      next.path === "/v1/oauth2/token" && next.status === 200
        ? { access_token: "REPLAY-TOKEN", token_type: "Bearer", expires_in: 32_400 }
        : next.responseBody;
    const headers = new Headers({ "content-type": "application/json" });
    if (next.debugId) {
      headers.set("paypal-debug-id", next.debugId);
    }
    return Promise.resolve(
      new Response(body === null ? null : JSON.stringify(body), { status: next.status, headers }),
    );
  };
  return { fetch: fetchImpl, remaining: () => queue.length };
}

/**
 * A buyer that answers with a run's recorded browser steps, in order.
 *
 * @param events - The recorded steps.
 * @returns The buyer.
 */
export function replayBuyer(events: readonly BuyerEvent[]): Buyer {
  const queue = [...events];
  const take = (kind: BuyerEvent["kind"]) => {
    const next = queue.shift();
    if (!next || next.kind !== kind) {
      throw new Error(`replay: a buyer ${kind} was not the next step recorded`);
    }
    return next.value;
  };
  const session: BuyerSession = {
    approve: () => Promise.resolve(take("approval") as Approval),
    activity: () => Promise.resolve(take("activity") as ActivityReading),
  };
  return {
    approve: (url) => session.approve(url),
    session: (steps) => steps(session),
    payByCard: () => Promise.resolve(take("card") as CardPayment),
  };
}

/**
 * Replays a probe's recording through the probe.
 *
 * @param probe - The probe.
 * @param recorded - The recorded run.
 * @returns The replayed run and how many recorded exchanges went unserved.
 */
export async function replay(
  probe: Probe,
  recorded: ProbeRun,
): Promise<{ run: ProbeRun; unserved: number }> {
  const served = replayFetch(recorded.exchanges);
  const run = await runOnce(probe, {
    clientId: "REPLAY-CLIENT",
    clientSecret: "REPLAY-SECRET",
    fetch: served.fetch,
    buyer: replayBuyer(recorded.buyer),
    options: recorded.options,
    now: () => new Date(recorded.startedAt),
    retryDelayMs: 0,
    sleep: () => Promise.resolve(),
  });
  return { run, unserved: served.remaining() };
}
