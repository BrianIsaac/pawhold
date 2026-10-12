import { z } from "zod";

import type { Executor } from "@/db/client";
import { auditActor, auditEvent, moneyState } from "@/db/schema";
import { money } from "@/money/currency";

const ACTION_SHAPE = /^[a-z][a-z_]*(\.[a-z][a-z_]*)*$/;

const optionalId = z.string().min(1).max(255).optional();

/** One thing that happened, as a caller hands it to the audit trail (plan 3.5). */
export const auditEventInput = z
  .strictObject({
    practiceId: z.uuid().optional(),
    caseId: z.uuid().optional(),
    actor: z.enum(auditActor.enumValues),
    action: z.string().max(100).regex(ACTION_SHAPE, "a dotted lower-case name"),
    moneyStateBefore: z.enum(moneyState.enumValues).optional(),
    moneyStateAfter: z.enum(moneyState.enumValues).optional(),
    amount: money.optional(),
    paypal: z
      .strictObject({
        orderId: optionalId,
        authorizationId: optionalId,
        captureId: optionalId,
        refundId: optionalId,
        debugId: optionalId,
      })
      .optional(),
    webhook: z
      .strictObject({
        eventId: z.string().min(1).nullable(),
        verified: z.boolean().nullable(),
      })
      .optional(),
    model: z
      .strictObject({
        id: z.string().min(1).max(255),
        inputSha256: z.string().regex(/^[0-9a-f]{64}$/, "a lower-case hex SHA-256"),
        output: z.json(),
      })
      .optional(),
    detail: z.record(z.string(), z.json()).optional(),
  })
  .refine((event) => event.caseId === undefined || event.practiceId !== undefined, {
    message: "an event about a case names the case's practice",
    path: ["practiceId"],
  });

export type AuditEventInput = z.input<typeof auditEventInput>;

export type AuditEventRecord = typeof auditEvent.$inferSelect;

/** An audit event refused before it reached the database. */
export class AuditEventInputError extends Error {
  override readonly name = "AuditEventInputError";

  /**
   * @param issues - What was wrong with the event, field by field.
   */
  constructor(readonly issues: readonly z.core.$ZodIssue[]) {
    super(`audit event refused: ${z.prettifyError(new z.ZodError([...issues]))}`);
  }
}

/** How an event is written, beside what it says. */
export interface AppendOptions {
  /**
   * When a seeded story's event happened (D16: a seeded case's history is
   * said to be seeded on its timeline). Only an event whose `detail.seeded`
   * is true may carry one; every other event is the database's clock.
   */
  readonly occurredAt?: Date;
}

/**
 * Appends one event to the audit trail. The trail is append-only: there is no
 * update or delete here, and the database refuses both (migration 0001).
 *
 * Pass the transaction that changes the state the event records, so the
 * event and the change commit or roll back together.
 *
 * @param executor - The pool or the open transaction to write in.
 * @param input - The event.
 * @param options - A seeded event's time.
 * @returns The stored event, with its id and the time it was written.
 * @throws AuditEventInputError when the event does not validate, or carries a time without being seeded.
 */
export async function appendAuditEvent(
  executor: Executor,
  input: AuditEventInput,
  options: AppendOptions = {},
): Promise<AuditEventRecord> {
  const parsed = auditEventInput.safeParse(input);
  if (!parsed.success) {
    throw new AuditEventInputError(parsed.error.issues);
  }
  const event = parsed.data;
  if (options.occurredAt !== undefined && event.detail?.seeded !== true) {
    throw new AuditEventInputError([
      {
        code: "custom",
        path: ["occurredAt"],
        message: "only a seeded event (detail.seeded) is written with a time of its own",
        input: options.occurredAt,
      },
    ]);
  }

  const [written] = await executor
    .insert(auditEvent)
    .values({
      ...(options.occurredAt === undefined ? {} : { occurredAt: options.occurredAt }),
      practiceId: event.practiceId ?? null,
      caseId: event.caseId ?? null,
      actor: event.actor,
      action: event.action,
      moneyStateBefore: event.moneyStateBefore ?? null,
      moneyStateAfter: event.moneyStateAfter ?? null,
      amountPence: event.amount?.pence ?? null,
      currencyCode: event.amount?.currency ?? null,
      paypalOrderId: event.paypal?.orderId ?? null,
      paypalAuthorizationId: event.paypal?.authorizationId ?? null,
      paypalCaptureId: event.paypal?.captureId ?? null,
      paypalRefundId: event.paypal?.refundId ?? null,
      paypalDebugId: event.paypal?.debugId ?? null,
      webhookEventId: event.webhook?.eventId ?? null,
      webhookVerified: event.webhook?.verified ?? null,
      modelId: event.model?.id ?? null,
      modelInputSha256: event.model?.inputSha256 ?? null,
      modelOutput: event.model?.output ?? null,
      detail: event.detail ?? {},
    })
    .returning();
  if (!written) {
    throw new Error("the audit insert returned no row");
  }
  return written;
}
