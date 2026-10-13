import { z } from "zod";

/** One entry of a PayPal error's `details` (the error schemas' `error_details`). */
export const paypalErrorDetail = z.object({
  field: z.string().optional(),
  value: z.string().optional(),
  location: z.string().optional(),
  issue: z.string(),
  description: z.string().optional(),
});

export type PayPalErrorDetail = z.infer<typeof paypalErrorDetail>;

const paypalLink = z.object({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
});

/** The body PayPal returns for every error but the identity ones (Responses page). */
const apiErrorBody = z.object({
  name: z.string().min(1),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z.array(paypalErrorDetail).optional(),
  links: z.array(paypalLink).optional(),
});

/** The body of an identity (OAuth) error (Responses page). */
const identityErrorBody = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});

/**
 * The response header the sandbox's answers carry (U0's recordings under
 * `probes/recorded/`, the token's included). It is the one place an identity
 * error, or an answer that is not JSON, says which request it was.
 */
const DEBUG_ID_HEADER = "paypal-debug-id";

/** The longest PayPal id the audit trail keeps; anything longer is not an id. */
const MAX_DEBUG_ID_LENGTH = 255;

/**
 * An error PayPal answered with. `name` is PayPal's own error name
 * (`UNPROCESSABLE_ENTITY`, or an identity error such as `invalid_client`),
 * not the class's; match a business refusal by `hasIssue`, since PayPal's
 * documents spell the 422 name two ways.
 */
export class PayPalError extends Error {
  override readonly name: string;
  readonly status: number;
  readonly debugId: string | null;
  readonly details: readonly PayPalErrorDetail[];
  readonly links: readonly z.infer<typeof paypalLink>[];

  /**
   * @param init - What PayPal answered.
   * @param init.status - The HTTP status.
   * @param init.name - PayPal's error name.
   * @param init.message - PayPal's message.
   * @param init.debugId - The body's `debug_id`, else the `Paypal-Debug-Id` header, when PayPal gave either.
   * @param init.details - PayPal's `details`.
   * @param init.links - PayPal's `links`.
   */
  constructor(init: {
    status: number;
    name: string;
    message: string;
    debugId: string | null;
    details: readonly PayPalErrorDetail[];
    links: readonly z.infer<typeof paypalLink>[];
  }) {
    super(init.message);
    this.name = init.name;
    this.status = init.status;
    this.debugId = init.debugId;
    this.details = init.details;
    this.links = init.links;
  }

  /**
   * Whether PayPal named this issue in the error's details.
   *
   * @param issue - The issue code, such as `PREVIOUSLY_CAPTURED`.
   * @returns True when one of the details carries it.
   */
  hasIssue(issue: string): boolean {
    return this.details.some((detail) => detail.issue === issue);
  }

  /**
   * Builds the error from a failed response's status, body text and headers.
   * The body's `debug_id` is kept where PayPal gives one the trail can keep;
   * the header's stands in where it does not.
   *
   * @param status - The HTTP status.
   * @param text - The response body as received.
   * @param headers - The response's headers.
   * @returns The error.
   */
  static fromResponse(status: number, text: string, headers?: Headers): PayPalError {
    const headerDebugId = usableDebugId(headers?.get(DEBUG_ID_HEADER));
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const api = apiErrorBody.safeParse(json);
    if (api.success) {
      return new PayPalError({
        status,
        name: api.data.name,
        message: api.data.message ?? api.data.name,
        debugId: usableDebugId(api.data.debug_id) ?? headerDebugId,
        details: api.data.details ?? [],
        links: api.data.links ?? [],
      });
    }
    const identity = identityErrorBody.safeParse(json);
    if (identity.success) {
      return new PayPalError({
        status,
        name: identity.data.error,
        message: identity.data.error_description ?? identity.data.error,
        debugId: headerDebugId,
        details: [],
        links: [],
      });
    }
    return new PayPalError({
      status,
      name: `HTTP_${status}`,
      message: `PayPal answered ${status} without an error body it documents`,
      debugId: headerDebugId,
      details: [],
      links: [],
    });
  }
}

/**
 * A debug id as the audit trail can keep it, whichever place PayPal gave it in.
 *
 * @param value - The body's `debug_id` or the `Paypal-Debug-Id` header.
 * @returns The id, or null when it is absent, empty or longer than the trail keeps.
 */
function usableDebugId(value: string | null | undefined): string | null {
  return value && value.length <= MAX_DEBUG_ID_LENGTH ? value : null;
}

/**
 * PayPal answered with a success whose body is not the shape the caller
 * expects. On a money POST the action has happened at PayPal: the caller
 * reads the resource back (or retries with the same `PayPal-Request-Id`)
 * rather than treating it as a failure.
 */
export class PayPalContractError extends Error {
  override readonly name = "PayPalContractError";

  /**
   * @param method - The request's method.
   * @param path - The request's path.
   * @param status - The HTTP status PayPal answered with.
   * @param issues - Where the body departed from the expected shape.
   */
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly issues: readonly z.core.$ZodIssue[],
  ) {
    super(
      `PayPal's ${status} answer to ${method} ${path} is not the expected shape: ${z.prettifyError(new z.ZodError([...issues]))}`,
    );
  }
}

/** The request never got an answer from PayPal (network failure or timeout). */
export class PayPalTransportError extends Error {
  override readonly name = "PayPalTransportError";

  /**
   * @param method - The request's method.
   * @param path - The request's path.
   * @param cause - What failed.
   */
  constructor(
    readonly method: string,
    readonly path: string,
    cause: unknown,
  ) {
    super(`no answer from PayPal to ${method} ${path}`, { cause });
  }
}
