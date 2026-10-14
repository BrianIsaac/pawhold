import { PayPalContractError, PayPalError, PayPalTransportError } from "@/paypal/client";
import { OrderRequestError } from "@/paypal/orders";

/** Why a money operation was refused. */
export type MoneyRefusal =
  | "request_invalid"
  | "case_not_found"
  | "version_not_found"
  | "hold_not_found"
  | "capture_not_found"
  | "wrong_state"
  | "version_not_awaiting"
  | "no_increase"
  | "bill_refused"
  | "bill_above_holds"
  | "refund_refused"
  | "paypal_refused"
  | "paypal_unavailable";

/** A money operation refused, with the reason a caller branches on. */
export class MoneyError extends Error {
  override readonly name = "MoneyError";

  /**
   * @param reason - Why, as a stable word.
   * @param message - Why, in words.
   * @param detail - PayPal's `debug_id` and issues when PayPal refused, and the error it came from.
   * @param detail.debugId - PayPal's `debug_id`.
   * @param detail.issues - PayPal's issue names.
   * @param detail.cause - The underlying error.
   */
  constructor(
    readonly reason: MoneyRefusal,
    message: string,
    readonly detail: {
      readonly debugId?: string | null;
      readonly issues?: readonly string[];
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
  }

  /** PayPal's issue names, when PayPal refused. */
  get issues(): readonly string[] {
    return this.detail.issues ?? [];
  }

  /** PayPal's `debug_id`, when PayPal refused. */
  get debugId(): string | null {
    return this.detail.debugId ?? null;
  }
}

/**
 * PayPal's answers that mean "not now" rather than "no": 408 for a request
 * that timed out on PayPal's side (on PayPal's SDK's list of statuses worth
 * asking again, and as the webhook certificate fetch already reads it), 409
 * for a request with the same `PayPal-Request-Id` still in progress, 429 for
 * too many.
 */
const RETRYABLE: ReadonlySet<number> = new Set([408, 409, 429]);

/**
 * Makes one call to PayPal, turning its failures into a refusal: a PayPal
 * answer of 4xx is `paypal_refused` with its `debug_id` and issues; no
 * answer, a 408, a 409, a 429, a 5xx or an answer of the wrong shape is
 * `paypal_unavailable`, and
 * the caller may retry, since every POST carries the same `PayPal-Request-Id`
 * and so acts at most once.
 *
 * @param what - The call, in words, for the message.
 * @param call - The call.
 * @returns PayPal's answer.
 * @throws MoneyError when PayPal refused or could not be reached.
 */
export async function askPayPal<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PayPalError && error.status < 500 && !RETRYABLE.has(error.status)) {
      throw new MoneyError("paypal_refused", `PayPal refused to ${what}: ${error.message}`, {
        debugId: error.debugId,
        issues: error.details.map((detail) => detail.issue),
        cause: error,
      });
    }
    if (
      error instanceof PayPalError ||
      error instanceof PayPalTransportError ||
      error instanceof PayPalContractError
    ) {
      throw new MoneyError(
        "paypal_unavailable",
        `PayPal did not answer the call to ${what}; retry`,
        {
          debugId: error instanceof PayPalError ? error.debugId : null,
          cause: error,
        },
      );
    }
    if (error instanceof OrderRequestError) {
      throw new MoneyError("request_invalid", error.message, { cause: error });
    }
    throw error;
  }
}
