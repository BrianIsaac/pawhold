import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { appendAuditEvent, type AuditEventInput } from "@/audit/writer";
import type { Database, Executor, Transaction } from "@/db/client";
import { auditActor, bill, estimateVersion, hold } from "@/db/schema";
import {
  type EstimateVersionView,
  loadEstimateVersion,
  sendEstimateVersion,
} from "@/estimate/version";
import type { PayPalClient } from "@/paypal/client";
import {
  approvalUrl,
  authorizeOrder,
  createAuthorizeOrder,
  onlyAuthorization,
  type Order,
  type OrderItem,
  paymentKindOf,
} from "@/paypal/orders";
import { parsePayPalTime, voidAuthorization } from "@/paypal/payments";
import { paypalRequestId } from "@/paypal/request-id";

import { askPayPal, MoneyError } from "./errors";
import {
  lockCase,
  type LockedCase,
  type MoneyState,
  moveCase,
  nextState,
  stateBeforeUpdate,
} from "./state";
import { caseHolds, heldTotal, type HoldView, holdView } from "./view";

/** What the money lifecycle's PayPal steps need. */
export interface MoneyDependencies {
  /** The pool: each step commits on its own, around PayPal's answer. */
  readonly db: Database["db"];
  readonly paypal: PayPalClient;
}

/** PayPal's limit on a purchase unit's description shown to the payer. */
const MAX_DESCRIPTION = 127;

const actor = z.enum(auditActor.enumValues);

const sendRequest = z.strictObject({ practiceId: z.uuid(), versionId: z.uuid(), actor });
const caseRequest = z.strictObject({ practiceId: z.uuid(), caseId: z.uuid(), actor });
const declineRequest = caseRequest.extend({ versionId: z.uuid().optional() });
const holdRequest = z.strictObject({ practiceId: z.uuid(), caseId: z.uuid(), holdId: z.uuid() });
const orderRequest = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  versionId: z.uuid(),
  experience: z
    .strictObject({
      brandName: z.string().min(1).max(127),
      locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
      returnUrl: z.url({ protocol: /^https$/ }).optional(),
      cancelUrl: z.url({ protocol: /^https$/ }).optional(),
    })
    .refine(
      (experience) => (experience.returnUrl === undefined) === (experience.cancelUrl === undefined),
      "a checkout by redirect needs both the return and the cancel URL; the JS SDK's window neither",
    )
    .optional(),
});

/** What {@link sendEstimate} answers. */
export interface SentEstimate {
  readonly version: EstimateVersionView;
  readonly moneyState: MoneyState;
}

/**
 * Sends an estimate version to the owner and moves the case in the same
 * transaction, writing the one `estimate.sent` event with the states before
 * and after (plan 3.2): a first estimate goes from draft to awaiting the
 * owner; an update, sent while the case is held, to awaiting the owner's
 * answer on the update. An update is refused when it adds nothing over what
 * is held: there is nothing for the owner to authorise.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the draft version and who sends it.
 * @returns The version as sent and the case's new state.
 * @throws MoneyError when the case is in no state to send it, or an update adds nothing.
 * @throws EstimateError when U2 refuses the send (sent already, no lines, list replaced).
 */
export async function sendEstimate(
  executor: Executor,
  request: z.input<typeof sendRequest>,
): Promise<SentEstimate> {
  const { practiceId, versionId, actor: by } = parse(sendRequest, request);
  return executor.transaction(async (tx) => {
    const draft = await loadEstimateVersion(tx, practiceId, versionId);
    if (!draft) {
      throw new MoneyError(
        "version_not_found",
        `the practice has no estimate version ${versionId}`,
      );
    }
    const kase = await lockCase(tx, practiceId, draft.caseId);
    const isUpdate = kase.moneyState === "held" || kase.moneyState === "update_declined";
    const to = nextState(isUpdate ? "send_update" : "send_estimate", kase.moneyState)!;
    if (isUpdate) {
      const [signed] = await tx.select({ id: bill.id }).from(bill).where(eq(bill.caseId, kase.id));
      if (signed) {
        throw new MoneyError(
          "wrong_state",
          "the case's bill is signed off: no update is sent after it, since discharge could only void its hold",
        );
      }
      const held = await heldTotal(tx, kase.id);
      if (draft.totals.highPence <= held) {
        throw new MoneyError(
          "no_increase",
          `version ${draft.number} tops out at ${draft.totals.highPence} pence, no more than the ${held} pence held: there is nothing for the owner to authorise`,
        );
      }
    }
    const version = await sendEstimateVersion(tx, {
      practiceId,
      versionId,
      actor: by,
      moneyState: { before: kase.moneyState, after: to },
    });
    await moveCase(tx, kase.id, to);
    return { version, moneyState: to };
  });
}

/** What {@link orderHold} answers. */
export interface OrderedHold {
  readonly hold: HoldView;
  /** PayPal's checkout link when the order was made for a redirect; null for the JS SDK. */
  readonly approvalUrl: string | null;
}

/**
 * Makes the PayPal `AUTHORIZE` order for the version awaiting the owner, for
 * the version's top less what the case already holds (D3), its lines
 * mirrored on the order (plan 3.3), and records the hold as ordered with
 * `hold.ordered`. Its `PayPal-Request-Id` is derived from the case, the hold
 * (the version's id) and the step, so asking again answers the same order.
 *
 * @param deps - The database and the PayPal client.
 * @param request - The practice, the case, the version the owner is shown, and how they approve.
 * @returns The hold and, for a redirect, PayPal's checkout link.
 * @throws MoneyError when the case awaits no owner's answer, the version is not the one awaiting, or PayPal refuses.
 */
export async function orderHold(
  deps: MoneyDependencies,
  request: z.input<typeof orderRequest>,
): Promise<OrderedHold> {
  const { practiceId, caseId, versionId, experience } = parse(orderRequest, request);
  const plan = await deps.db.transaction(async (tx) => {
    const kase = await lockCase(tx, practiceId, caseId);
    const [existing] = await tx.select().from(hold).where(eq(hold.id, versionId));
    if (existing && existing.status !== "ordered") {
      return { kase, existing, order: null } as const;
    }
    return {
      kase,
      existing: existing ?? null,
      order: await planOrder(tx, kase, versionId),
    } as const;
  });
  if (!plan.order) {
    return { hold: await loadHold(deps.db, practiceId, caseId, versionId), approvalUrl: null };
  }

  const { kase, order: planned } = plan;
  const order = await asking(deps.db, refusedEvent(kase, "owner", "hold.order_refused", {}), () =>
    askPayPal("create the order", () =>
      createAuthorizeOrder(deps.paypal, {
        amount: { pence: planned.amountPence, currency: kase.currency },
        referenceId: versionId,
        customId: `${caseId}/${versionId}`,
        description: orderDescription(kase, planned.heldBeforePence > 0),
        requestId: holdRequestId(caseId, versionId, "order.create"),
        items: planned.items,
        ...(planned.heldBeforePence > 0
          ? { discount: { pence: planned.heldBeforePence, currency: kase.currency } }
          : {}),
        ...(experience ? { experience } : {}),
      }),
    ),
  );

  const stored = await deps.db.transaction(async (tx) => {
    const locked = await lockCase(tx, practiceId, caseId);
    const again = await planOrder(tx, locked, versionId);
    if (again.heldBeforePence !== planned.heldBeforePence) {
      throw new MoneyError(
        "wrong_state",
        "what the case holds changed while the order was made; ask again",
      );
    }
    const [inserted] = await tx
      .insert(hold)
      .values({
        id: versionId,
        practiceId,
        caseId,
        versionNumber: again.versionNumber,
        versionHighPence: again.versionHighPence,
        heldBeforePence: again.heldBeforePence,
        amountPence: again.amountPence,
        currencyCode: locked.currency,
        status: "ordered",
        paypalOrderId: order.id,
      })
      .onConflictDoNothing({ target: hold.id })
      .returning();
    if (inserted) {
      await appendAuditEvent(tx, {
        practiceId,
        caseId,
        actor: "owner",
        action: "hold.ordered",
        amount: { pence: inserted.amountPence, currency: locked.currency },
        paypal: { orderId: order.id },
        detail: {
          holdId: inserted.id,
          versionNumber: inserted.versionNumber,
          heldBeforePence: inserted.heldBeforePence,
        },
      });
      return inserted;
    }
    const [current] = await tx.select().from(hold).where(eq(hold.id, versionId));
    if (current!.paypalOrderId !== order.id) {
      throw new MoneyError(
        "wrong_state",
        `PayPal answered with order ${order.id}, but the hold is for order ${current!.paypalOrderId}: the hold's order is kept`,
      );
    }
    return current!;
  });
  return {
    hold: holdView(stored, 0),
    approvalUrl: experience?.returnUrl ? approvalUrl(order) : null,
  };
}

/** What an order for a version is made of, read under the case's lock. */
interface PlannedOrder {
  readonly versionNumber: number;
  readonly versionHighPence: number;
  readonly heldBeforePence: number;
  readonly amountPence: number;
  readonly items: OrderItem[];
}

/**
 * Checks a version is the one awaiting the owner and works out its order:
 * every line at its top quantity, in the owner's words where the vet gave
 * them, and the hold the top less what is already held.
 *
 * @param tx - The open transaction holding the case's lock.
 * @param kase - The locked case.
 * @param versionId - The version.
 * @returns The order's terms.
 * @throws MoneyError when the case awaits no answer, the version is not the latest sent, or there is nothing to hold.
 */
async function planOrder(
  tx: Transaction,
  kase: LockedCase,
  versionId: string,
): Promise<PlannedOrder> {
  if (kase.moneyState !== "awaiting_owner" && kase.moneyState !== "update_awaiting_owner") {
    throw new MoneyError(
      "wrong_state",
      `the case is ${kase.moneyState.replaceAll("_", " ")}: no estimate awaits the owner`,
    );
  }
  const awaiting = await latestSentVersionId(tx, kase.id);
  if (awaiting !== versionId) {
    throw new MoneyError(
      "version_not_awaiting",
      `version ${versionId} is not the estimate awaiting the owner`,
    );
  }
  const version = await loadEstimateVersion(tx, kase.practiceId, versionId);
  if (!version) {
    throw new MoneyError("version_not_found", `the practice has no estimate version ${versionId}`);
  }
  const heldBeforePence = await heldTotal(tx, kase.id);
  const amountPence = version.totals.highPence - heldBeforePence;
  if (amountPence <= 0) {
    throw new MoneyError("no_increase", `version ${version.number} adds nothing over what is held`);
  }
  return {
    versionNumber: version.number,
    versionHighPence: version.totals.highPence,
    heldBeforePence,
    amountPence,
    items: version.lines.map((line) => ({
      name: line.ownerWording ?? line.name,
      sku: line.code,
      quantity: line.quantityHigh,
      unitAmount: { pence: line.unitPricePence, currency: kase.currency },
    })),
  };
}

/**
 * The case's latest sent version: the one awaiting the owner while the case
 * awaits an answer.
 *
 * @param executor - The pool or an open transaction.
 * @param caseId - The case.
 * @returns Its id, or null when none was sent.
 */
async function latestSentVersionId(executor: Executor, caseId: string): Promise<string | null> {
  const [latest] = await executor
    .select({ id: estimateVersion.id })
    .from(estimateVersion)
    .where(and(eq(estimateVersion.caseId, caseId), isNotNull(estimateVersion.sentAt)))
    .orderBy(desc(estimateVersion.number))
    .limit(1);
  return latest?.id ?? null;
}

/**
 * Authorises the hold's order once the owner has approved it, and moves the
 * case to held (a second hold for an update) with `hold.authorised` carrying
 * the order and authorisation ids. A state changes on PayPal's answer (rule
 * 5). Asking again answers the hold as it stands. When PayPal's
 * authorisation lands after the estimate was withdrawn or the update
 * declined, the authorisation is voided at once (`hold.voided`), so nothing
 * stays held for an estimate no one is waiting on.
 *
 * @param deps - The database and the PayPal client.
 * @param request - The practice, the case and the hold.
 * @returns The hold.
 * @throws MoneyError when there is no such hold, or PayPal refuses or cannot be reached.
 */
export async function authoriseHold(
  deps: MoneyDependencies,
  request: z.input<typeof holdRequest>,
): Promise<HoldView> {
  const { practiceId, caseId, holdId } = parse(holdRequest, request);
  const found = await loadHold(deps.db, practiceId, caseId, holdId);
  if (found.status !== "ordered" && found.status !== "withdrawn" && found.status !== "declined") {
    return found;
  }

  const authorised = await asking(
    deps.db,
    refusedEvent({ id: caseId, practiceId }, "owner", "hold.authorise_refused", {
      orderId: found.paypalOrderId,
    }),
    () =>
      askPayPal("authorise the order", () =>
        authorizeOrder(
          deps.paypal,
          found.paypalOrderId,
          holdRequestId(caseId, holdId, "order.authorize"),
        ),
      ),
  );
  const authorisation = readAuthorisation(authorised);

  const outcome = await deps.db.transaction(async (tx) => {
    const kase = await lockCase(tx, practiceId, caseId);
    const [row] = await tx.select().from(hold).where(eq(hold.id, holdId)).for("update");
    if (row!.status === "authorised") {
      return { settled: holdView(row!, 0) } as const;
    }
    const awaiting =
      row!.status === "ordered" &&
      (kase.moneyState === "awaiting_owner" || kase.moneyState === "update_awaiting_owner");
    if (!awaiting) {
      return { kase, row: row! } as const;
    }
    const to = nextState("authorise", kase.moneyState)!;
    const [updated] = await tx
      .update(hold)
      .set({
        status: "authorised",
        authorizationId: authorisation.id,
        originalAuthorizationId: authorisation.id,
        paymentKind: authorisation.kind,
        authorisedAt: authorisation.createdAt,
        expiresAt: authorisation.expiresAt,
        updatedAt: sql`now()`,
      })
      .where(eq(hold.id, holdId))
      .returning();
    await moveCase(tx, caseId, to);
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: "owner",
      action: "hold.authorised",
      moneyStateBefore: kase.moneyState,
      moneyStateAfter: to,
      amount: { pence: updated!.amountPence, currency: kase.currency },
      paypal: { orderId: updated!.paypalOrderId, authorizationId: authorisation.id },
      detail: {
        holdId,
        versionNumber: updated!.versionNumber,
        paymentKind: authorisation.kind,
        expiresAt: authorisation.expiresAt?.toISOString() ?? null,
      },
    });
    return { settled: holdView(updated!, 0) } as const;
  });
  if ("settled" in outcome) {
    return outcome.settled;
  }

  // PayPal holds money for an estimate no one is waiting on: release it now.
  await askPayPal("void the authorisation", () =>
    voidAuthorization(deps.paypal, authorisation.id, holdRequestId(caseId, holdId, "void")),
  );
  return deps.db.transaction(async (tx) => {
    const kase = await lockCase(tx, practiceId, caseId);
    const [updated] = await tx
      .update(hold)
      .set({
        status: "voided",
        authorizationId: authorisation.id,
        originalAuthorizationId: authorisation.id,
        paymentKind: authorisation.kind,
        authorisedAt: authorisation.createdAt,
        expiresAt: authorisation.expiresAt,
        closedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(hold.id, holdId), inArray(hold.status, ["ordered", "withdrawn", "declined"])))
      .returning();
    if (!updated) {
      return loadHold(tx, practiceId, caseId, holdId);
    }
    await appendAuditEvent(tx, {
      practiceId,
      caseId,
      actor: "system",
      action: "hold.voided",
      amount: { pence: updated!.amountPence, currency: kase.currency },
      paypal: { orderId: updated!.paypalOrderId, authorizationId: authorisation.id },
      detail: {
        holdId,
        reason: `the owner's authorisation answered after the hold was ${outcome.row.status}`,
        releasedPence: updated!.amountPence,
      },
    });
    return holdView(updated!, 0);
  });
}

/** The authorisation an authorised order holds, as the hold records it. */
interface ReadAuthorisation {
  readonly id: string;
  readonly kind: "paypal" | "card";
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/**
 * Reads the authorisation from PayPal's answer to an authorise.
 *
 * @param authorised - The order as `authorize` answered it.
 * @returns The authorisation.
 * @throws MoneyError when PayPal did not hold the money (an authorisation not `CREATED`) or the answer lacks what a hold records.
 */
function readAuthorisation(authorised: Order): ReadAuthorisation {
  let found;
  try {
    found = onlyAuthorization(authorised);
  } catch (error) {
    throw new MoneyError(
      "paypal_unavailable",
      `PayPal's authorise answer does not hold one authorisation; ask again`,
      { cause: error },
    );
  }
  if (found.status !== "CREATED") {
    throw new MoneyError(
      "paypal_refused",
      `PayPal answered the authorisation ${found.status}, not CREATED: nothing is held`,
    );
  }
  const kind = paymentKindOf(authorised);
  if (!kind || !found.create_time) {
    throw new MoneyError(
      "paypal_unavailable",
      "PayPal's authorise answer names no payment source or time; ask again",
    );
  }
  return {
    id: found.id,
    kind,
    createdAt: parsePayPalTime(found.create_time),
    expiresAt: found.expiration_time ? parsePayPalTime(found.expiration_time) : null,
  };
}

/**
 * Withdraws the estimate awaiting the owner (plan 3.2: "order left
 * unapproved; nothing to void"): a first estimate's case becomes withdrawn;
 * an update's returns to where it was sent from. Its order, if one was made,
 * is recorded as withdrawn and never authorised after.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the case and who withdraws.
 * @returns The case's new state.
 * @throws MoneyError when no estimate awaits the owner.
 */
export async function withdrawEstimate(
  executor: Executor,
  request: z.input<typeof caseRequest>,
): Promise<MoneyState> {
  const { practiceId, caseId, actor: by } = parse(caseRequest, request);
  return closeAwaiting(executor, { practiceId, caseId, actor: by }, "withdraw");
}

/**
 * The owner declines the update awaiting them (plan 3.2: held --owner
 * declines the update--> held, update declined): the case stays held at what
 * its holds cover, scope frozen there, and the update's order, if one was
 * made, is recorded as declined and never authorised after. Given the
 * version the owner was shown, the decline is refused unless that version is
 * the update awaiting them, checked under the case's lock, so an older
 * update's link never declines a newer one (U6).
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the case, who declines (the owner) and the version they were shown.
 * @returns The case's new state.
 * @throws MoneyError when no update awaits the owner, or the version shown is not the one awaiting.
 */
export async function declineUpdate(
  executor: Executor,
  request: z.input<typeof declineRequest>,
): Promise<MoneyState> {
  const { practiceId, caseId, actor: by, versionId } = parse(declineRequest, request);
  return closeAwaiting(
    executor,
    { practiceId, caseId, actor: by, ...(versionId ? { shownVersionId: versionId } : {}) },
    "decline_update",
  );
}

/**
 * Closes the estimate awaiting the owner, by withdrawal or the owner's
 * decline, with one audit event.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the case and who acts.
 * @param request.practiceId - The practice.
 * @param request.caseId - The case.
 * @param request.actor - Who acts.
 * @param request.shownVersionId - The version the owner was shown, when they act.
 * @param event - Which.
 * @returns The case's new state.
 * @throws MoneyError when no estimate awaits an answer, or the version shown is not the one awaiting.
 */
async function closeAwaiting(
  executor: Executor,
  request: {
    practiceId: string;
    caseId: string;
    actor: z.output<typeof actor>;
    shownVersionId?: string;
  },
  event: "withdraw" | "decline_update",
): Promise<MoneyState> {
  return executor.transaction(async (tx) => {
    const kase = await lockCase(tx, request.practiceId, request.caseId);
    const to = nextState(event, kase.moneyState) ?? (await stateBeforeUpdate(tx, kase.id));
    const versionId = await latestSentVersionId(tx, kase.id);
    if (request.shownVersionId !== undefined && request.shownVersionId !== versionId) {
      throw new MoneyError(
        "version_not_awaiting",
        `version ${request.shownVersionId} is not the estimate awaiting the owner`,
      );
    }
    const [ordered] = versionId
      ? await tx
          .update(hold)
          .set({
            status: event === "withdraw" ? "withdrawn" : "declined",
            closedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(and(eq(hold.id, versionId), eq(hold.status, "ordered")))
          .returning()
      : [];
    await moveCase(tx, kase.id, to);
    await appendAuditEvent(tx, {
      practiceId: request.practiceId,
      caseId: kase.id,
      actor: request.actor,
      action: event === "withdraw" ? "estimate.withdrawn" : "estimate.update_declined",
      moneyStateBefore: kase.moneyState,
      moneyStateAfter: to,
      ...(ordered ? { paypal: { orderId: ordered.paypalOrderId } } : {}),
      detail: { versionId, holdId: ordered?.id ?? null },
    });
    return to;
  });
}

/**
 * Loads a practice's case's hold with what it has captured.
 *
 * @param executor - The pool or an open transaction.
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @param holdId - The hold.
 * @returns The hold.
 * @throws MoneyError when the case has no such hold.
 */
export async function loadHold(
  executor: Executor,
  practiceId: string,
  caseId: string,
  holdId: string,
): Promise<HoldView> {
  const found = (await caseHolds(executor, caseId)).find((one) => one.id === holdId);
  const [scoped] = await executor
    .select({ id: hold.id })
    .from(hold)
    .where(and(eq(hold.id, holdId), eq(hold.caseId, caseId), eq(hold.practiceId, practiceId)));
  if (!found || !scoped) {
    throw new MoneyError("hold_not_found", `the case has no hold ${holdId}`);
  }
  return found;
}

/**
 * The `PayPal-Request-Id` of a step against a hold (plan 3.2, rule 4).
 *
 * @param caseId - The case.
 * @param holdId - The hold.
 * @param step - The step, such as `capture.1`.
 * @returns The request id.
 */
export function holdRequestId(caseId: string, holdId: string, step: string): string {
  return paypalRequestId({ caseId, holdId, step });
}

/**
 * The order's description, as the owner sees it on PayPal's page.
 *
 * @param kase - The case.
 * @param isUpdate - Whether the order is for an update.
 * @returns The description, at most PayPal's 127 characters.
 */
function orderDescription(kase: LockedCase, isUpdate: boolean): string {
  const text = `${kase.patientName}'s ${isUpdate ? "updated " : ""}estimate from ${kase.practiceName}`;
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 3)}...` : text;
}

/**
 * The audit event a PayPal refusal of a step writes, before the refusal's
 * own details are known.
 *
 * @param kase - The case.
 * @param by - Who asked.
 * @param action - The event's action.
 * @param paypal - The PayPal ids the step was about.
 * @returns The event, waiting for the refusal.
 */
export function refusedEvent(
  kase: Pick<LockedCase, "id" | "practiceId">,
  by: z.output<typeof actor>,
  action: string,
  paypal: NonNullable<AuditEventInput["paypal"]>,
): (refusal: MoneyError) => AuditEventInput {
  return (refusal) => ({
    practiceId: kase.practiceId,
    caseId: kase.id,
    actor: by,
    action,
    paypal: { ...paypal, ...(refusal.debugId ? { debugId: refusal.debugId } : {}) },
    detail: { reason: refusal.message, issues: [...refusal.issues] },
  });
}

/**
 * Runs a PayPal step and, when PayPal refuses it, writes the refusal to the
 * audit trail with PayPal's `debug_id` (plan 3.5) before passing it on.
 *
 * @param db - The pool.
 * @param event - The refusal's audit event.
 * @param step - The step.
 * @returns The step's answer.
 * @throws MoneyError as the step does.
 */
export async function asking<T>(
  db: Database["db"],
  event: (refusal: MoneyError) => AuditEventInput,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof MoneyError && error.reason === "paypal_refused") {
      await appendAuditEvent(db, event(error));
    }
    throw error;
  }
}

/**
 * Parses a request, turning a malformed one into a refusal.
 *
 * @param schema - The request's schema.
 * @param request - The request.
 * @returns The parsed request.
 * @throws MoneyError when the request does not parse.
 */
export function parse<T extends z.ZodType>(schema: T, request: unknown): z.output<T> {
  const parsed = schema.safeParse(request);
  if (!parsed.success) {
    throw new MoneyError(
      "request_invalid",
      `money request refused: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
