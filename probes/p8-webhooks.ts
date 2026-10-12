import { createCertificateCache, verifyByPostback, verifyWebhook } from "@/paypal/webhooks";

import { captureAuthorization, refundCapture, voidAuthorization } from "@/paypal/payments";
import { gbp, makeWalletHold, type Observation, type Probe, type ProbeContext } from "./probe";

/*
 * P8. Webhook lag and verification, against U1's listener deployed (decision
 * D6). Ten cycles of authorise, capture, void and refund; each event the
 * cycle should cause is looked for among the listener's stored deliveries
 * (`webhook_event`), its lag taken from PayPal's API answer to the row's
 * `received_at`, and each stored delivery verified again both ways: by the
 * CRC32 signature against PayPal's certificate, and by the
 * verify-webhook-signature postback.
 */

const CYCLES = 10;
/** The plan's bar: the 95th percentile of the lag under ten seconds. */
const P95_BAR_SECONDS = 10;
const WAIT_AFTER_LAST_MS = 5 * 60 * 1000;
const POLL_EVERY_MS = 5_000;
const MAX_POLLS = WAIT_AFTER_LAST_MS / POLL_EVERY_MS;

const BRANCH =
  "The screens move on PayPal's API answer and show the webhook's tick when it lands (\"Confirmed by PayPal\"); the video's cut waits on the tick and, if it is long, shows it sped up with the real time in a caption. A failed verification is a defect to fix in U1, not a branch.";

/** One delivery as the listener stored it. */
export interface StoredDelivery {
  readonly eventId: string;
  readonly eventType: string;
  readonly resourceId: string | null;
  /** How the listener verified it: `signature` or `postback`. */
  readonly verification: string;
  readonly isMock: boolean;
  /** When the listener stored it, ISO 8601. */
  readonly receivedAt: string;
  readonly rawBody: string;
  readonly transmissionId: string;
  readonly transmissionTime: string;
  readonly certUrl: string | null;
  readonly authAlgo: string;
  /** The signature header; null when the listener does not keep it. */
  readonly transmissionSig: string | null;
}

/** Where P8 reads the listener's deliveries. */
export interface WebhookStore {
  /** Whether the store keeps each delivery's signature, which re-verifying needs. */
  keepsSignatures(): Promise<boolean>;
  /** The deliveries about any of these resources. */
  find(resourceIds: readonly string[]): Promise<StoredDelivery[]>;
  close(): Promise<void>;
}

/** What P8 needs from outside the run. */
export interface P8Setup {
  /** The webhook id of the listener's subscription (`PAYPAL_WEBHOOK_ID`). */
  readonly webhookId: string | undefined;
  /** The deployed database's URL (`P8_DATABASE_URL`). */
  readonly storeUrl: string | undefined;
  readonly openStore: (url: string) => WebhookStore;
}

/** An event a step should cause, and when PayPal answered the step. */
export interface Expectation {
  readonly cycle: number;
  readonly eventTypes: readonly string[];
  readonly resourceId: string;
  readonly answeredAt: string;
}

/** An expectation and the delivery that met it, if one did. */
export interface Arrival {
  readonly expected: Expectation;
  readonly delivery: StoredDelivery | null;
  /** Seconds from the API answer to the listener's `received_at`. */
  readonly lagSeconds: number | null;
}

/**
 * Pairs each expected event with the first stored delivery of its type about
 * its resource.
 *
 * @param expected - The expected events.
 * @param stored - The listener's deliveries.
 * @returns One arrival per expectation, in order.
 */
export function matchArrivals(
  expected: readonly Expectation[],
  stored: readonly StoredDelivery[],
): Arrival[] {
  return expected.map((e) => {
    const delivery =
      stored
        .filter((d) => d.resourceId === e.resourceId && e.eventTypes.includes(d.eventType))
        .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))[0] ?? null;
    return {
      expected: e,
      delivery,
      lagSeconds: delivery
        ? (Date.parse(delivery.receivedAt) - Date.parse(e.answeredAt)) / 1000
        : null,
    };
  });
}

/**
 * The 95th percentile by nearest rank, a missing arrival counting as infinite.
 *
 * @param lags - The lags in seconds, null for an event that never came.
 * @returns The percentile, or null for no lags at all.
 */
export function percentile95(lags: readonly (number | null)[]): number | null {
  if (lags.length === 0) {
    return null;
  }
  const sorted = lags.map((l) => l ?? Number.POSITIVE_INFINITY).sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

/**
 * How many cycles saw their events stored in an order other than the steps'.
 *
 * @param arrivals - The arrivals, in the order the steps were taken.
 * @returns The count.
 */
export function cyclesOutOfOrder(arrivals: readonly Arrival[]): number {
  const cycles = new Map<number, number[]>();
  for (const a of arrivals) {
    if (a.delivery) {
      cycles.set(a.expected.cycle, [
        ...(cycles.get(a.expected.cycle) ?? []),
        Date.parse(a.delivery.receivedAt),
      ]);
    }
  }
  return [...cycles.values()].filter((times) => times.some((t, i) => i > 0 && t < times[i - 1]!))
    .length;
}

/**
 * The delivery's transmission headers, as PayPal sent them.
 *
 * @param d - The delivery.
 * @returns The headers.
 */
function headersOf(d: StoredDelivery): Headers {
  return new Headers({
    "paypal-transmission-id": d.transmissionId,
    "paypal-transmission-time": d.transmissionTime,
    "paypal-transmission-sig": d.transmissionSig ?? "",
    "paypal-cert-url": d.certUrl ?? "",
    "paypal-auth-algo": d.authAlgo,
  });
}

/**
 * Runs one cycle: a hold, a part capture, the void of the rest and the
 * capture's refund, noting the events each should cause.
 *
 * @param context - The run's context.
 * @param cycle - The cycle's number.
 * @returns What the cycle expects.
 */
async function runCycle(context: ProbeContext, cycle: number): Promise<Expectation[]> {
  const name = `p8.${cycle}`;
  const at = () => context.now().toISOString();
  const hold = await makeWalletHold(context, name, gbp(10_000));
  const expected: Expectation[] = [
    {
      cycle,
      eventTypes: ["PAYMENT.AUTHORIZATION.CREATED"],
      resourceId: hold.authorization.id,
      answeredAt: at(),
    },
  ];
  const capture = await captureAuthorization(context.client, hold.authorization.id, {
    amount: gbp(6_000),
    finalCapture: false,
    requestId: context.requestId(name, "capture"),
  });
  expected.push({
    cycle,
    eventTypes: ["PAYMENT.CAPTURE.COMPLETED"],
    resourceId: capture.id,
    answeredAt: at(),
  });
  await voidAuthorization(context.client, hold.authorization.id, context.requestId(name, "void"));
  expected.push({
    cycle,
    eventTypes: ["PAYMENT.AUTHORIZATION.VOIDED"],
    resourceId: hold.authorization.id,
    answeredAt: at(),
  });
  const refund = await refundCapture(context.client, capture.id, context.requestId(name, "refund"));
  expected.push({
    cycle,
    eventTypes: ["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.REFUND.COMPLETED"],
    resourceId: refund.id,
    answeredAt: at(),
  });
  return expected;
}

/**
 * P8, built over the listener's store.
 *
 * @param setup - The webhook id, the store's URL and how to open it.
 * @returns The probe.
 */
export function createP8(setup: P8Setup): Probe {
  return {
    id: "P8",
    title: "Webhook lag and verification",
    question: `Ten cycles of authorise, capture, void and refund against U1's deployed listener: does every event arrive, verify by the CRC32 signature and by the verify-webhook-signature postback, in order, with the 95th percentile of the lag from PayPal's API answer to the listener's \`received_at\` under ${P95_BAR_SECONDS} s?`,
    async run(context) {
      const missing = [
        setup.webhookId ? null : "PAYPAL_WEBHOOK_ID (the listener's subscription)",
        setup.storeUrl ? null : "P8_DATABASE_URL (the deployed database, reachable from here)",
      ].filter((m): m is string => m !== null);
      if (missing.length > 0 || !setup.webhookId || !setup.storeUrl) {
        return owed(`there is no deployed listener to read yet: missing ${missing.join(", ")}`);
      }
      const store = setup.openStore(setup.storeUrl);
      try {
        if (!(await store.keepsSignatures())) {
          return owed(
            "the listener's webhook_event keeps no transmission_sig, so a stored delivery cannot be verified again by either method",
          );
        }
        const expected: Expectation[] = [];
        for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
          expected.push(...(await runCycle(context, cycle)));
        }
        const lastAnswer = Date.parse(expected.at(-1)!.answeredAt);
        const ids = [...new Set(expected.map((e) => e.resourceId))];
        let arrivals = matchArrivals(expected, await store.find(ids));
        for (
          let polls = 0;
          polls < MAX_POLLS &&
          arrivals.some((a) => a.delivery === null) &&
          context.now().getTime() - lastAnswer < WAIT_AFTER_LAST_MS;
          polls += 1
        ) {
          await context.sleep(POLL_EVERY_MS);
          arrivals = matchArrivals(expected, await store.find(ids));
        }
        return await judge(context, setup.webhookId, arrivals);
      } finally {
        await store.close();
      }
    },
  };
}

/**
 * Verifies each arrival both ways and reaches the verdict.
 *
 * @param context - The run's context.
 * @param webhookId - The subscription's id.
 * @param arrivals - The arrivals.
 * @returns The outcome.
 */
async function judge(context: ProbeContext, webhookId: string, arrivals: readonly Arrival[]) {
  const certificates = createCertificateCache();
  let bySignature = 0;
  let byPostback = 0;
  for (const a of arrivals) {
    if (!a.delivery) {
      continue;
    }
    const verdict = await verifyWebhook({
      rawBody: new TextEncoder().encode(a.delivery.rawBody),
      headers: headersOf(a.delivery),
      webhookId,
      certificates,
    });
    if (verdict.outcome === "verified" && verdict.method === "signature") {
      bySignature += 1;
    }
    const posted = await verifyByPostback(
      context.client,
      headersOf(a.delivery),
      webhookId,
      a.delivery.rawBody,
    ).catch((error: unknown) => {
      context.note(
        `postback of ${a.delivery!.eventId} got no verdict: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "UNAVAILABLE" as const;
    });
    if (posted === "SUCCESS") {
      byPostback += 1;
    }
  }
  const arrived = arrivals.filter((a) => a.delivery !== null);
  const p95 = percentile95(arrivals.map((a) => a.lagSeconds));
  const outOfOrder = cyclesOutOfOrder(arrivals);
  const lags = arrived.map((a) => a.lagSeconds!).sort((x, y) => x - y);
  const observations: Record<string, Observation> = {
    "events expected": arrivals.length,
    "events arrived": arrived.length,
    "verified by signature": bySignature,
    "verified by postback": byPostback,
    "listener's own method": [...new Set(arrived.map((a) => a.delivery!.verification))].join(", "),
    "certificate hosts": [
      ...new Set(
        arrived.map((a) => (a.delivery!.certUrl ? new URL(a.delivery!.certUrl).host : "none")),
      ),
    ].join(", "),
    "lag p95 (s)": p95 === null || !Number.isFinite(p95) ? null : p95,
    "lag median (s)": lags.length > 0 ? lags[Math.floor(lags.length / 2)]! : null,
    "lag max (s)": lags.at(-1) ?? null,
    "cycles out of order": outOfOrder,
    "missing events": arrivals
      .filter((a) => a.delivery === null)
      .map((a) => `${a.expected.eventTypes[0]} ${a.expected.resourceId}`)
      .join("; "),
  };
  const pass =
    arrived.length === arrivals.length &&
    bySignature === arrivals.length &&
    byPostback === arrivals.length &&
    outOfOrder === 0 &&
    p95 !== null &&
    p95 < P95_BAR_SECONDS;
  return {
    verdict: pass ? ("pass" as const) : ("fail" as const),
    summary: `${arrived.length} of ${arrivals.length} events arrived; ${bySignature} verified by signature and ${byPostback} by postback; p95 lag ${p95 === null || !Number.isFinite(p95) ? "unbounded" : `${p95} s`}; ${outOfOrder} cycles out of order.`,
    observations,
    branch: pass ? null : BRANCH,
  };
}

/**
 * P8's answer while its listener does not exist yet.
 *
 * @param reason - What is missing.
 * @returns The owed outcome.
 */
function owed(reason: string) {
  return {
    verdict: "owed" as const,
    summary: `Owed to the day U1's listener is deployed: ${reason}. No PayPal call was made.`,
    observations: {
      command:
        "env $(grep -E '^PAYPAL_' ~/.config/briain/secrets.env | xargs) PAYPAL_WEBHOOK_ID=<id> P8_DATABASE_URL=<url> pnpm probes P8 --record",
    },
    branch: null,
  };
}
