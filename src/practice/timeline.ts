import { and, asc, eq, isNotNull } from "drizzle-orm";

import type { AuditEventRecord } from "@/audit/writer";
import type { Executor } from "@/db/client";
import { auditEvent, capture, hold, patientCase, refund } from "@/db/schema";
import { currencyCode } from "@/money/currency";
import { formatMoney } from "@/money/format";

import { firstName } from "./chips";
import { PracticeError } from "./errors";
import { practiceDay, practiceMinute, practiceSecond } from "./time";

/** One fact of the raw event, behind "Show PayPal and model details". */
export interface TimelineFact {
  readonly term: string;
  readonly value: string;
}

/** One event of a case's timeline, read in plain words (plan 3.5, section 6). */
export interface TimelineRow {
  readonly id: number;
  readonly action: string;
  /** When it happened, ISO 8601. */
  readonly at: string;
  /** The day, as the practice reads it ("Tuesday 7 October"). */
  readonly day: string;
  /** The time to the minute ("14:02"). */
  readonly time: string;
  readonly who: string;
  readonly what: string;
  /** "Seeded for the demo" on a seeded event (D16). */
  readonly note?: string;
  readonly details: readonly TimelineFact[];
}

/** What an event's words need of its case. */
export interface DescribeContext {
  readonly vetName: string | null;
  readonly ownerFirstName: string;
  readonly patientName: string;
  /**
   * When PayPal's webhook confirmed each thing, by `hold:{id}`,
   * `capture:{PayPal capture id}` and `refund:{PayPal refund id}`.
   */
  readonly confirmations: ReadonlyMap<string, Date>;
}

type Detail = Record<string, unknown>;

/** The event as a describer reads it. */
interface Described {
  readonly event: AuditEventRecord;
  readonly detail: Detail;
  readonly context: DescribeContext;
  /** The event's amount, formatted; "an amount" when it has none. */
  readonly amount: string;
  /** Formats pence in the event's currency. */
  readonly money: (pence: unknown) => string;
}

/**
 * The words of one action. Section 6 drafts one example ("Owner authorised a
 * hold of £640.00 (PayPal, confirmed 14:02:11)"); the rest are this unit's,
 * flagged (D11).
 */
const WORDS: Record<string, (event: Described) => string> = {
  "case.opened": ({ detail, context }) =>
    `opened the case for ${text(detail.patientName) ?? context.patientName}`,
  "estimate.version_made": ({ detail, money }) =>
    Number(detail.lineCount) === 0
      ? `made version ${text(detail.number)} of the estimate, with no lines yet`
      : `made version ${text(detail.number)} of the estimate, ${money(detail.lowPence)} to ${money(detail.highPence)}`,
  "estimate.draft_changed": ({ detail, money }) =>
    `changed draft version ${text(detail.number)}: ${money(detail.lowPence)} to ${money(detail.highPence)}`,
  "estimate.drafted": ({ detail }) => askWords(detail, "the notes"),
  "estimate.update_drafted": ({ detail }) => askWords(detail, "the finding"),
  "estimate.approved": ({ detail }) => `approved version ${text(detail.number)}`,
  "estimate.sent": ({ event, detail, money, amount, context }) =>
    event.moneyStateAfter === "update_awaiting_owner"
      ? `sent an update to ${context.ownerFirstName}: the estimate is now ${money(detail.lowPence)} to ${money(detail.highPence)}`
      : `sent the estimate to ${context.ownerFirstName}: ${money(detail.lowPence)} to ${money(detail.highPence)}, a hold of ${amount}`,
  "estimate.withdrawn": ({ event }) =>
    event.moneyStateBefore === "update_awaiting_owner"
      ? "withdrew the update"
      : "withdrew the estimate",
  "estimate.update_declined": () => "declined the update",
  "hold.ordered": ({ amount }) => `opened PayPal's checkout for a hold of ${amount}`,
  "hold.order_refused": () => "asked PayPal for the order; PayPal refused it",
  "hold.authorised": ({ detail, amount, context }) => {
    const kind = detail.paymentKind === "card" ? "card" : "PayPal";
    const confirmed = context.confirmations.get(`hold:${text(detail.holdId)}`);
    return `authorised a hold of ${amount} (${kind}${confirmed ? `, confirmed ${practiceSecond(confirmed)}` : ""})`;
  },
  "hold.authorise_refused": () => "approved, but PayPal refused the authorisation",
  "hold.voided": ({ amount }) => `released ${amount}: the hold was voided`,
  "hold.void_refused": () => "asked PayPal to void the hold; PayPal refused",
  "hold.captured": ({ event, detail, amount, money, context }) => {
    const released = Number(detail.releasedPence ?? 0);
    const confirmed = event.paypalCaptureId
      ? context.confirmations.get(`capture:${event.paypalCaptureId}`)
      : undefined;
    return `captured ${amount}${released > 0 ? `, ${money(released)} released` : ""}${confirmed ? ` (confirmed ${practiceSecond(confirmed)})` : ""}`;
  },
  "hold.capture_declined": ({ amount }) => `PayPal declined the capture of ${amount}`,
  "hold.capture_refused": () => "asked PayPal to capture the hold; PayPal refused",
  "hold.expired": ({ amount }) => `found the hold of ${amount} expired at PayPal`,
  "hold.reauthorised": ({ amount }) => `extended the hold of ${amount}: PayPal reauthorised it`,
  "hold.reauthorise_refused": () => "asked PayPal to extend the hold; PayPal refused",
  "hold.honour_period_over": ({ amount }) =>
    `flagged the hold of ${amount}: its honour period is over`,
  "bill.signed_off": ({ amount }) => `signed off the bill: ${amount}`,
  "capture.refund_requested": ({ amount }) => `asked PayPal to refund ${amount}`,
  "capture.refund_refused": () => "asked PayPal for a refund; PayPal refused",
  "capture.refunded": ({ event, amount, context }) => {
    const confirmed = event.paypalRefundId
      ? context.confirmations.get(`refund:${event.paypalRefundId}`)
      : undefined;
    return `refunded ${amount}${confirmed ? ` (confirmed ${practiceSecond(confirmed)})` : ""}`;
  },
  "capture.refund_failed": ({ amount }) => `PayPal answered that the refund of ${amount} failed`,
  "webhook.reconciled": ({ detail }) =>
    `webhook ${text(detail.eventType)} verified and matched${detail.holdId ? " to the hold" : ""}`,
  "webhook.flagged": ({ detail }) =>
    `webhook ${text(detail.eventType)} flagged: ${text(detail.reason) ?? "it does not match the case"}`,
};

/** Every action the timeline has words of its own for. */
export const DESCRIBED_ACTIONS: ReadonlySet<string> = new Set(Object.keys(WORDS));

/**
 * A detail's value as text, or null when it has none.
 *
 * @param value - The value.
 * @returns The text.
 */
function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * The words of an agent's ask: how many lines it drafted from the vet's
 * words, and from where; or that it did not work.
 *
 * @param detail - The ask's detail.
 * @param from - Whose words.
 * @returns The words.
 */
function askWords(detail: Detail, from: string): string {
  if (detail.failure) {
    return `asked for a draft from ${from}; it didn't work (${text(detail.failure)})`;
  }
  const source = detail.source === "cache" ? "the practice's cached answer" : "model";
  return `drafted ${text(detail.draftedLines) ?? "no"} lines from ${from} (${source})`;
}

/**
 * Who acted, as the timeline names them.
 *
 * @param event - The event.
 * @param detail - Its detail.
 * @param context - The case.
 * @returns The name.
 */
function who(event: AuditEventRecord, detail: Detail, context: DescribeContext): string {
  switch (event.actor) {
    case "vet":
      return text(detail.vetName) ?? context.vetName ?? "Vet";
    case "owner":
      return "Owner";
    case "system":
      return "pawhold";
    case "schedule_agent":
      return "Schedule agent";
    case "paypal_webhook":
      return "PayPal";
  }
}

/**
 * A money state in words.
 *
 * @param value - The state.
 * @returns The words.
 */
function state(value: string | null): string {
  return value === null ? "none" : value.replaceAll("_", " ");
}

/** The longest model output shown behind the disclosure. */
const MAX_OUTPUT = 4_000;

/**
 * The raw event behind the disclosure: the action, the states, the amount,
 * PayPal's ids, the webhook, the model, and the event itself.
 *
 * @param event - The event.
 * @param amount - Its amount, formatted.
 * @returns The facts.
 */
function facts(event: AuditEventRecord, amount: string | null): TimelineFact[] {
  const all: [string, string | null][] = [
    ["Action", event.action],
    [
      "Money state",
      event.moneyStateBefore || event.moneyStateAfter
        ? `${state(event.moneyStateBefore)} to ${state(event.moneyStateAfter)}`
        : null,
    ],
    ["Amount", amount],
    ["PayPal order", event.paypalOrderId],
    ["PayPal authorisation", event.paypalAuthorizationId],
    ["PayPal capture", event.paypalCaptureId],
    ["PayPal refund", event.paypalRefundId],
    ["PayPal debug id", event.paypalDebugId],
    ["Webhook event", event.webhookEventId],
    [
      "Webhook verified",
      event.webhookVerified === null ? null : event.webhookVerified ? "yes" : "no",
    ],
    ["Model", event.modelId],
    ["Model input SHA-256", event.modelInputSha256],
    [
      "Model output",
      event.modelOutput === null ? null : truncate(JSON.stringify(event.modelOutput), MAX_OUTPUT),
    ],
    ["Event", `#${event.id} at ${event.occurredAt.toISOString()}`],
    [
      "Detail",
      Object.keys(event.detail as Detail).length === 0 ? null : JSON.stringify(event.detail),
    ],
  ];
  return all
    .filter((fact): fact is [string, string] => fact[1] !== null)
    .map(([term, value]) => ({ term, value }));
}

/**
 * Text cut to a length, marked when cut.
 *
 * @param value - The text.
 * @param max - The most characters.
 * @returns The text.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)} (cut at ${max} characters)`;
}

/**
 * One audit event in plain words: "{time} {who}: {what}" (section 6), with
 * the raw event behind the disclosure.
 *
 * @param event - The event.
 * @param context - The case.
 * @returns The row.
 */
export function describeEvent(event: AuditEventRecord, context: DescribeContext): TimelineRow {
  const detail = (event.detail ?? {}) as Detail;
  const currency = currencyCode.safeParse(event.currencyCode).success
    ? currencyCode.parse(event.currencyCode)
    : "GBP";
  const money = (pence: unknown): string =>
    typeof pence === "number" && Number.isInteger(pence)
      ? formatMoney({ pence, currency })
      : "an amount";
  const amount = event.amountPence === null ? null : money(event.amountPence);
  const words = WORDS[event.action];
  const what = words
    ? words({ event, detail, context, amount: amount ?? "an amount", money })
    : event.action.replaceAll(".", ": ").replaceAll("_", " ");
  return {
    id: event.id,
    action: event.action,
    at: event.occurredAt.toISOString(),
    day: practiceDay(event.occurredAt),
    time: practiceMinute(event.occurredAt),
    who: who(event, detail, context),
    what,
    ...(detail.seeded === true ? { note: "Seeded for the demo" } : {}),
    details: facts(event, amount),
  };
}

/**
 * A case's timeline (plan 3.5): every event of its audit trail, in the order
 * written, newest last, each in plain words with "confirmed {time}" where
 * PayPal's webhook confirmed it (U3's `confirmedAt`).
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The rows.
 * @throws PracticeError `case_not_found` when the practice has no such case.
 */
export async function caseTimeline(
  executor: Executor,
  practiceId: string,
  caseId: string,
): Promise<TimelineRow[]> {
  const [kase] = await executor
    .select({
      vetName: patientCase.vetName,
      ownerName: patientCase.ownerName,
      patientName: patientCase.patientName,
    })
    .from(patientCase)
    .where(and(eq(patientCase.id, caseId), eq(patientCase.practiceId, practiceId)));
  if (!kase) {
    throw new PracticeError("case_not_found", `the practice has no case ${caseId}`);
  }
  const [events, holds, captures, refunds] = await Promise.all([
    executor
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.caseId, caseId), eq(auditEvent.practiceId, practiceId)))
      .orderBy(asc(auditEvent.id)),
    executor
      .select({ id: hold.id, at: hold.confirmedAt })
      .from(hold)
      .where(and(eq(hold.caseId, caseId), isNotNull(hold.confirmedAt))),
    executor
      .select({ id: capture.paypalCaptureId, at: capture.confirmedAt })
      .from(capture)
      .innerJoin(hold, eq(hold.id, capture.holdId))
      .where(and(eq(hold.caseId, caseId), isNotNull(capture.confirmedAt))),
    executor
      .select({ id: refund.paypalRefundId, at: refund.confirmedAt })
      .from(refund)
      .innerJoin(capture, eq(capture.id, refund.captureId))
      .innerJoin(hold, eq(hold.id, capture.holdId))
      .where(and(eq(hold.caseId, caseId), isNotNull(refund.confirmedAt))),
  ]);
  const confirmations = new Map<string, Date>([
    ...holds.map((one) => [`hold:${one.id}`, one.at!] as const),
    ...captures.map((one) => [`capture:${one.id}`, one.at!] as const),
    ...refunds
      .filter((one) => one.id !== null)
      .map((one) => [`refund:${one.id}`, one.at!] as const),
  ]);
  const context: DescribeContext = {
    vetName: kase.vetName,
    ownerFirstName: firstName(kase.ownerName),
    patientName: kase.patientName,
    confirmations,
  };
  return events.map((event) => describeEvent(event, context));
}
