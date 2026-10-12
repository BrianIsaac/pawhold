import { randomUUID } from "node:crypto";

import type { Money } from "@/money/currency";
import { type PayPalClient, PayPalError } from "@/paypal/client";
import { paypalRequestId } from "@/paypal/request-id";

import type { Buyer } from "./buyer";
import { approvalUrl, authorizeOrder, getOrder, onlyAuthorization } from "@/paypal/orders";
import { type Authorization, getAuthorization, voidAuthorization } from "@/paypal/payments";
import { createProbeOrder } from "./orders";

/** The probes of the plan's section 4, P5 split by its three dates, and the smoke run. */
export const PROBE_IDS = [
  "SMOKE",
  "P1",
  "P2",
  "P3",
  "P4",
  "P5A",
  "P5B",
  "P5C",
  "P6",
  "P7",
  "P8",
  "P9",
] as const;

export type ProbeId = (typeof PROBE_IDS)[number];

/** A probe's answer to its question, dated by the run. */
export type Verdict = "pass" | "fail" | "owed";

/** A fact a probe read from PayPal, for the report and the replay test. */
export type Observation = string | number | boolean | null;

/** What one run of a probe found. */
export interface ProbeOutcome {
  readonly verdict: Verdict;
  /** One or two sentences: what PayPal did. */
  readonly summary: string;
  /** The facts the verdict rests on, by name. */
  readonly observations: Readonly<Record<string, Observation>>;
  /** On a "no", the plan's branch taken; null otherwise. */
  readonly branch: string | null;
}

/** Options a probe may read from the command line. */
export interface ProbeOptions {
  /** P5 (b) and (c): the authorisations P5 (a) and P6 left standing. */
  readonly holds: readonly string[];
  /** Which run of the probe this is, from 1. */
  readonly run: number;
}

/** What a probe works with. */
export interface ProbeContext {
  /** The sandbox client; every exchange is recorded. */
  readonly client: PayPalClient;
  /** The buyer's headless browser. */
  readonly buyer: Buyer;
  /** The authorisations this run made. */
  readonly holds: HoldLedger;
  readonly options: ProbeOptions;
  /** A `PayPal-Request-Id` for a step against a named hold of this run (U1's derivation). */
  requestId(hold: string, step: string): string;
  /** Adds a line to the run's timeline. */
  note(text: string): void;
  /** When the run started (the run's own record of it). */
  readonly startedAt: Date;
  /** The clock. */
  now(): Date;
  /** Waits; immediate in a replay. */
  sleep(ms: number): Promise<void>;
}

/** A probe of section 4. */
export interface Probe {
  readonly id: ProbeId;
  readonly title: string;
  /** The question as the plan puts it, and its pass condition. */
  readonly question: string;
  run(context: ProbeContext): Promise<ProbeOutcome>;
}

/**
 * An order a run made and the authorisation it holds, and whether that is
 * left standing on purpose. The order is recorded before it is authorised,
 * so an authorisation whose answer was lost is still found and closed.
 */
export interface HeldAuthorization {
  readonly hold: string;
  readonly orderId: string;
  /** The authorisation, or null until the authorise call has answered. */
  authorizationId: string | null;
  /** Why it is left standing (P5 (b)), or null when the run must close it. */
  kept: string | null;
}

/** The orders and authorisations one run made, for the clean-up and its check. */
export class HoldLedger {
  readonly entries: HeldAuthorization[] = [];

  /**
   * Records an order about to be authorised.
   *
   * @param hold - The hold's name within the run.
   * @param orderId - The order.
   */
  order(hold: string, orderId: string): void {
    this.entries.push({ hold, orderId, authorizationId: null, kept: null });
  }

  /**
   * Records the authorisation an order's authorise call answered with.
   *
   * @param orderId - The order.
   * @param authorizationId - Its authorisation.
   * @throws Error when the run did not record the order.
   */
  authorised(orderId: string, authorizationId: string): void {
    const entry = this.entries.find((e) => e.orderId === orderId);
    if (!entry) {
      throw new Error(`order ${orderId} was not recorded by this run`);
    }
    entry.authorizationId = authorizationId;
  }

  /**
   * Records an authorisation this run reached that it did not authorise
   * from an order of its own: a reauthorisation, or a standing hold it
   * closes.
   *
   * @param hold - The hold's name within the run.
   * @param orderId - The order the authorisation belongs to.
   * @param authorizationId - The authorisation.
   */
  record(hold: string, orderId: string, authorizationId: string): void {
    this.entries.push({ hold, orderId, authorizationId, kept: null });
  }

  /**
   * Marks an authorisation to be left standing on purpose.
   *
   * @param authorizationId - The authorisation.
   * @param reason - Why, and until when.
   * @throws Error when the run did not make it.
   */
  keep(authorizationId: string, reason: string): void {
    const entry = this.entries.find((e) => e.authorizationId === authorizationId);
    if (!entry) {
      throw new Error(`authorisation ${authorizationId} was not made by this run`);
    }
    entry.kept = reason;
  }
}

/**
 * Builds the context for one run of a probe.
 *
 * @param client - The (recording) client.
 * @param buyer - The buyer.
 * @param options - The command line's options.
 * @param now - The clock.
 * @param sleep - How to wait.
 * @param startedAt - When the run started; now by default.
 * @returns The context and the run's timeline.
 */
export function createContext(
  client: PayPalClient,
  buyer: Buyer,
  options: ProbeOptions,
  now: () => Date = () => new Date(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
  startedAt: Date = now(),
): { context: ProbeContext; notes: { at: string; text: string }[] } {
  const caseId = randomUUID();
  const holdIds = new Map<string, string>();
  const notes: { at: string; text: string }[] = [];
  const context: ProbeContext = {
    client,
    buyer,
    holds: new HoldLedger(),
    options,
    requestId: (hold, step) => {
      if (!holdIds.has(hold)) {
        holdIds.set(hold, randomUUID());
      }
      return paypalRequestId({ caseId, holdId: holdIds.get(hold)!, step });
    },
    note: (text) => notes.push({ at: now().toISOString(), text }),
    startedAt,
    now,
    sleep,
  };
  return { context, notes };
}

/** A hold made through the buyer's PayPal account. */
export interface WalletHold {
  readonly orderId: string;
  readonly authorization: Authorization;
}

/**
 * Makes a wallet hold: an `AUTHORIZE` order, approved by the buyer in the
 * headless browser (or in the session given), then authorised; the
 * authorisation goes into the run's ledger.
 *
 * @param context - The run's context.
 * @param hold - The hold's name within the run, such as `a`.
 * @param amount - The amount to hold.
 * @param approve - How to approve (a P9 session); a browser of its own by default.
 * @returns The order's id and the authorisation.
 */
export async function makeWalletHold(
  context: ProbeContext,
  hold: string,
  amount: Money,
  approve: (url: string) => Promise<unknown> = (url) => context.buyer.approve(url),
): Promise<WalletHold> {
  const created = await createProbeOrder(context.client, {
    amount,
    referenceId: `probe-${hold}`,
    customId: `pawhold-probe-${hold}`,
    requestId: context.requestId(hold, "order.create"),
  });
  await approve(approvalUrl(created));
  context.note(`order ${created.id} approved by the buyer`);
  context.holds.order(hold, created.id);
  const authorised = await authorizeOrder(
    context.client,
    created.id,
    context.requestId(hold, "order.authorize"),
  );
  const authorization = onlyAuthorization(authorised);
  context.holds.authorised(created.id, authorization.id);
  return { orderId: created.id, authorization };
}

/** Authorisation statuses that hold nothing. */
const CLOSED = new Set(["CAPTURED", "VOIDED", "DENIED", "EXPIRED"]);

/** One row of the clean-up check. */
export interface CleanRow {
  readonly orderId: string;
  /** The authorisation, or null when the order was never authorised. */
  readonly authorizationId: string | null;
  /** The authorisation's status, or the order's when it holds none. */
  readonly status: string;
  readonly kept: string | null;
  readonly ok: boolean;
}

/** The clean-up check: each authorisation the run made, and whether the run is clean. */
export interface CleanCheck {
  readonly rows: readonly CleanRow[];
  readonly clean: boolean;
}

/**
 * Finds the authorisation of an order whose authorise call did not answer,
 * by reading the order.
 *
 * @param client - The sandbox client.
 * @param entry - The ledger's entry; its authorisation is filled in when found.
 * @returns The order's status when it holds no authorisation, else null.
 */
async function resolveAuthorization(
  client: PayPalClient,
  entry: HeldAuthorization,
): Promise<string | null> {
  if (entry.authorizationId !== null) {
    return null;
  }
  const read = await getOrder(client, entry.orderId);
  const found = (read.purchase_units ?? []).flatMap((u) => u.payments?.authorizations ?? []);
  if (found[0]) {
    entry.authorizationId = found[0].id;
    return null;
  }
  return read.status;
}

/**
 * Closes whatever the run left open that it was not told to keep: voids each
 * authorisation still `CREATED` or `PARTIALLY_CAPTURED`, including one whose
 * authorise call lost its answer. A probe that ended early (a refusal, an
 * error) is closed here; a probe that ended as designed has nothing to close.
 *
 * @param context - The run's context.
 */
export async function releaseLeftovers(context: ProbeContext): Promise<void> {
  for (const entry of context.holds.entries.filter((e) => e.kept === null)) {
    try {
      await resolveAuthorization(context.client, entry);
      if (entry.authorizationId === null) {
        continue;
      }
      const read = await getAuthorization(context.client, entry.authorizationId);
      if (CLOSED.has(read.status)) {
        continue;
      }
      await voidAuthorization(
        context.client,
        entry.authorizationId,
        context.requestId(entry.hold, "cleanup.void"),
      );
      context.note(`clean-up voided ${entry.authorizationId} (was ${read.status})`);
    } catch (error) {
      context.note(
        `clean-up could not close ${entry.authorizationId ?? `order ${entry.orderId}`}: ${failure(error)}`,
      );
    }
  }
}

/**
 * Lists the run's authorisations as PayPal now states them and asserts each
 * is captured or voided, or is a hold kept on purpose and still `CREATED`.
 * An order never authorised holds nothing and passes; one that cannot be
 * read fails the check, and the rest are still read.
 *
 * @param client - The sandbox client.
 * @param holds - The run's ledger.
 * @returns The check.
 */
export async function checkClean(client: PayPalClient, holds: HoldLedger): Promise<CleanCheck> {
  const rows: CleanRow[] = [];
  for (const entry of holds.entries) {
    try {
      const orderStatus = await resolveAuthorization(client, entry);
      if (entry.authorizationId === null) {
        rows.push({
          orderId: entry.orderId,
          authorizationId: null,
          status: `order ${orderStatus ?? "unread"}, not authorised`,
          kept: entry.kept,
          ok: true,
        });
        continue;
      }
      const { status } = await getAuthorization(client, entry.authorizationId);
      const ok = entry.kept === null ? CLOSED.has(status) : status === "CREATED";
      rows.push({
        orderId: entry.orderId,
        authorizationId: entry.authorizationId,
        status,
        kept: entry.kept,
        ok,
      });
    } catch (error) {
      rows.push({
        orderId: entry.orderId,
        authorizationId: entry.authorizationId,
        status: `unread: ${failure(error)}`,
        kept: entry.kept,
        ok: false,
      });
    }
  }
  return { rows, clean: rows.every((r) => r.ok) };
}

/**
 * A failure in a few words: PayPal's error name and issues, or the error's
 * first line.
 *
 * @param error - What was thrown.
 * @returns The description.
 */
function failure(error: unknown): string {
  if (error instanceof PayPalError) {
    return `${error.name} ${error.details.map((d) => d.issue).join(", ")}`.trim();
  }
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);
}

/**
 * Whether a refusal is PayPal declining the request on its merits (a 422),
 * not PayPal failing to answer it (a 5xx, a 429) or refusing the caller.
 *
 * @param error - The refusal.
 * @returns True for a business refusal.
 */
export function isBusinessRefusal(error: PayPalError): boolean {
  return error.status === 422;
}

/**
 * Runs a PayPal call that may be refused, answering the refusal instead of
 * throwing it.
 *
 * @param call - The call.
 * @returns The result, or PayPal's error.
 */
export async function attempt<T>(
  call: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: PayPalError }> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (error instanceof PayPalError) {
      return { ok: false, error };
    }
    throw error;
  }
}

/**
 * The issues of a PayPal refusal, comma separated, for an observation.
 *
 * @param error - The refusal.
 * @returns The issues, or the error's name when it has none.
 */
export function issues(error: PayPalError): string {
  return error.details.length > 0 ? error.details.map((d) => d.issue).join(", ") : error.name;
}

/**
 * Pounds as pence in GBP.
 *
 * @param pence - The amount in pence.
 * @returns The money.
 */
export function gbp(pence: number): Money {
  return { pence, currency: "GBP" };
}
