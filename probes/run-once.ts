import { createPayPalClient } from "@/paypal/client";

import type { ActivityReading, Approval, Buyer, BuyerSession } from "./buyer";
import {
  type CleanCheck,
  checkClean,
  createContext,
  type Probe,
  type ProbeId,
  type ProbeOptions,
  type ProbeOutcome,
  releaseLeftovers,
} from "./probe";
import { type Exchange, recordingFetch } from "./recorder";
import { retryingFetch } from "./retry";

/** What the buyer's browser did in a run, in order. */
export type BuyerEvent =
  | { readonly kind: "approval"; readonly value: Approval }
  | { readonly kind: "activity"; readonly value: ActivityReading };

/** One run of one probe: what was sent, what PayPal answered, the verdict and the clean-up. */
export interface ProbeRun {
  readonly probe: ProbeId;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly options: ProbeOptions;
  /** The probe's verdict, or null when the run broke before reaching one. */
  readonly outcome: ProbeOutcome | null;
  /** What broke, when the run did not reach a verdict. */
  readonly error: string | null;
  readonly exchanges: readonly Exchange[];
  readonly buyer: readonly BuyerEvent[];
  readonly notes: readonly { readonly at: string; readonly text: string }[];
  readonly cleanup: CleanCheck | null;
}

/** What a run needs from outside. */
export interface RunDependencies {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The fetch that reaches PayPal (or replays a recording). */
  readonly fetch: typeof fetch;
  readonly buyer: Buyer;
  readonly options: ProbeOptions;
  readonly now?: () => Date;
  /** The wait before retrying a request that got no answer; 2 s by default. */
  readonly retryDelayMs?: number;
}

/** How long the probes wait for PayPal on one request, retries included. */
const PROBE_TIMEOUT_MS = 90_000;

/**
 * Runs a probe once: the probe, then the clean-up of anything it left open
 * that it was not told to keep, then the check that lists every
 * authorisation the run made as PayPal now states it. Every PayPal exchange
 * (each attempt of a retried one) and every browser step is recorded.
 *
 * @param probe - The probe.
 * @param deps - Credentials, the fetch, the buyer, the options.
 * @returns The run.
 */
export async function runOnce(probe: Probe, deps: RunDependencies): Promise<ProbeRun> {
  const now = deps.now ?? (() => new Date());
  const exchanges: Exchange[] = [];
  const events: BuyerEvent[] = [];
  const client = createPayPalClient({
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    environment: "sandbox",
    timeoutMs: PROBE_TIMEOUT_MS,
    fetch: retryingFetch(
      recordingFetch(deps.fetch, exchanges, () => now().getTime()),
      { attempts: 4, delayMs: deps.retryDelayMs ?? 2_000 },
    ),
  });
  const { context, notes } = createContext(
    client,
    recordingBuyer(deps.buyer, events),
    deps.options,
    now,
  );
  const startedAt = now().toISOString();
  let outcome: ProbeOutcome | null = null;
  let error: string | null = null;
  try {
    outcome = await probe.run(context);
  } catch (thrown) {
    error = describeError(thrown);
  }
  let cleanup: CleanCheck | null = null;
  try {
    await releaseLeftovers(context);
    cleanup = await checkClean(client, context.holds);
  } catch (thrown) {
    error = [error, `clean-up: ${describeError(thrown)}`].filter(Boolean).join("; ");
  }
  return {
    probe: probe.id,
    startedAt,
    endedAt: now().toISOString(),
    options: deps.options,
    outcome,
    error,
    exchanges,
    buyer: events,
    notes,
    cleanup,
  };
}

/**
 * Wraps a buyer so that each approval and activity reading is recorded.
 *
 * @param inner - The buyer.
 * @param events - Where the steps are appended.
 * @returns The recording buyer.
 */
export function recordingBuyer(inner: Buyer, events: BuyerEvent[]): Buyer {
  const wrap = (session: BuyerSession): BuyerSession => ({
    approve: async (url) => {
      const value = await session.approve(url);
      events.push({ kind: "approval", value });
      return value;
    },
    activity: async () => {
      const value = await session.activity();
      events.push({ kind: "activity", value });
      return value;
    },
  });
  return {
    approve: (url) => inner.session((s) => wrap(s).approve(url)),
    session: (steps) => inner.session((s) => steps(wrap(s))),
  };
}

/**
 * An error as one line, with its causes.
 *
 * @param error - What was thrown.
 * @returns The description.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 4) {
    const first = current.message.split("\n")[0] ?? "";
    parts.push(`${current.name}: ${first}`);
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(" <- ") : String(error);
}
