import { z } from "zod";

import { PayPalContractError, PayPalError, PayPalTransportError } from "./errors";

export { PayPalContractError, PayPalError, PayPalTransportError } from "./errors";
export type { PayPalErrorDetail } from "./errors";

/**
 * The PayPal environments pawhold talks to. Sandbox only: the hackathon's
 * rules ask for "the free sandbox environment" and no real money moves.
 */
export const PAYPAL_API_BASE_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
} as const;

export type PayPalEnvironment = keyof typeof PAYPAL_API_BASE_URLS;

const TOKEN_PATH = "/v1/oauth2/token";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * An optional field of PayPal's answer that reads an explicit `null` as
 * absent, as PayPal's own SDK reads one (`optional()` in `@apimatic/schema`).
 * A field that is present and not null must still match its schema.
 *
 * @param schema - The field's schema.
 * @returns The schema, optional, with `null` read as `undefined`.
 */
export function optionalField<T extends z.ZodType>(schema: T) {
  return schema
    .nullish()
    .transform((value) => value ?? undefined)
    .optional();
}

/** The token answer, as the Authentication page's sample response shows it. */
const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive(),
  scope: optionalField(z.string()),
  app_id: optionalField(z.string()),
  nonce: optionalField(z.string()),
});

type ApiPath = `/v${number}/${string}`;

/** What every request to the API takes. */
interface RequestOptions<T> {
  /** The schema PayPal's answer must match; it is parsed before it is returned. */
  readonly response: z.ZodType<T>;
  /** Extra headers, such as `Prefer`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A POST: a `PayPal-Request-Id` is required, or `null` for an endpoint without one. */
export type PostOptions<T> = RequestOptions<T> & {
  /** The idempotency key (plan 3.2, rule 4); see `paypalRequestId`. */
  readonly requestId: string | null;
} & (
    | { readonly body?: unknown; readonly rawJsonBody?: never }
    | {
        /** A JSON body sent byte for byte, for the webhook postback. */
        readonly rawJsonBody: string;
        readonly body?: never;
      }
  );

/** A successful answer: its status and its parsed body. */
export interface PayPalResponse<T> {
  readonly status: number;
  readonly body: T;
}

/** How a client is built. */
export interface PayPalClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly environment: PayPalEnvironment;
  /** Overrides the environment's base URL; for the tests' mock server. */
  readonly baseUrl?: string;
  /** The fetch to call; the global one by default. */
  readonly fetch?: typeof fetch;
  /** The clock, in milliseconds since the epoch. */
  readonly now?: () => number;
  /** How long to wait for PayPal on each request. */
  readonly timeoutMs?: number;
}

/** A client for PayPal's REST APIs, holding one cached OAuth token. */
export interface PayPalClient {
  /**
   * Sends a GET.
   *
   * @param path - The API path, such as `/v2/checkout/orders/{id}`.
   * @param options - The expected answer's schema.
   * @returns PayPal's answer.
   */
  get<T>(path: ApiPath, options: RequestOptions<T>): Promise<PayPalResponse<T>>;
  /**
   * Sends a POST with its `PayPal-Request-Id`.
   *
   * @param path - The API path.
   * @param options - The body, the request id and the expected answer's schema.
   * @returns PayPal's answer.
   */
  post<T>(path: ApiPath, options: PostOptions<T>): Promise<PayPalResponse<T>>;
}

interface CachedToken {
  readonly value: string;
  readonly refreshAt: number;
}

/**
 * Builds a PayPal REST client. The OAuth token is fetched on first use,
 * shared by concurrent callers, refreshed before it runs out, and refreshed
 * once more when PayPal answers 401; the retried request carries the same
 * `PayPal-Request-Id`, so it cannot act twice.
 *
 * @param options - Credentials, environment and test seams.
 * @returns The client.
 */
export function createPayPalClient(options: PayPalClientOptions): PayPalClient {
  const baseUrl = options.baseUrl ?? PAYPAL_API_BASE_URLS[options.environment];
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const basicAuth = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64");

  let cached: CachedToken | null = null;
  let pending: Promise<CachedToken> | null = null;

  const send = async (method: string, path: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        method,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PayPalTransportError(method, path, error);
    }
  };

  const fetchToken = async (): Promise<CachedToken> => {
    const startedAt = now();
    const answer = await send("POST", TOKEN_PATH, {
      headers: {
        accept: "application/json",
        authorization: `Basic ${basicAuth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const text = await readText(answer, "POST", TOKEN_PATH);
    if (!answer.ok) {
      throw PayPalError.fromResponse(answer.status, text, answer.headers);
    }
    const parsed = tokenResponse.safeParse(parseJson(text));
    if (!parsed.success) {
      throw new PayPalContractError("POST", TOKEN_PATH, answer.status, parsed.error.issues);
    }
    const lifetimeMs = parsed.data.expires_in * 1000;
    const margin = Math.min(MAX_REFRESH_MARGIN_MS, lifetimeMs / 10);
    return { value: parsed.data.access_token, refreshAt: startedAt + lifetimeMs - margin };
  };

  const token = async (): Promise<string> => {
    if (cached && now() < cached.refreshAt) {
      return cached.value;
    }
    pending ??= fetchToken().finally(() => {
      pending = null;
    });
    cached = await pending;
    return cached.value;
  };

  const invalidate = (used: string): void => {
    if (cached?.value === used) {
      cached = null;
    }
  };

  const call = async <T>(
    method: "GET" | "POST",
    path: ApiPath,
    headers: Record<string, string>,
    body: string | undefined,
    schema: z.ZodType<T>,
  ): Promise<PayPalResponse<T>> => {
    let answer: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bearer = await token();
      answer = await send(method, path, {
        headers: { accept: "application/json", ...headers, authorization: `Bearer ${bearer}` },
        ...(body === undefined ? {} : { body }),
      });
      if (answer.status !== 401) {
        break;
      }
      invalidate(bearer);
      if (attempt === 0) {
        await answer.body?.cancel();
      }
    }
    const final = answer!;
    const text = await readText(final, method, path);
    if (!final.ok) {
      throw PayPalError.fromResponse(final.status, text, final.headers);
    }
    const parsed = schema.safeParse(text.length === 0 ? null : parseJson(text));
    if (!parsed.success) {
      throw new PayPalContractError(method, path, final.status, parsed.error.issues);
    }
    return { status: final.status, body: parsed.data };
  };

  return {
    get: (path, { response, headers }) => call("GET", path, { ...headers }, undefined, response),
    post: (path, postOptions) => {
      const headers: Record<string, string> = {
        ...postOptions.headers,
        "content-type": "application/json",
      };
      if (postOptions.requestId !== null) {
        headers["paypal-request-id"] = postOptions.requestId;
      }
      const body =
        postOptions.rawJsonBody ??
        (postOptions.body === undefined ? undefined : JSON.stringify(postOptions.body));
      return call("POST", path, headers, body, postOptions.response);
    },
  };
}

/**
 * Reads an answer's body, reporting a read that fails part way (a reset, a
 * timeout) as a transport failure: for a money POST, the outcome is unknown
 * and the caller retries with the same `PayPal-Request-Id`.
 *
 * @param answer - The response.
 * @param method - The request's method.
 * @param path - The request's path.
 * @returns The body text.
 * @throws PayPalTransportError when the body cannot be read.
 */
async function readText(answer: Response, method: string, path: string): Promise<string> {
  try {
    return await answer.text();
  } catch (error) {
    throw new PayPalTransportError(method, path, error);
  }
}

/**
 * Parses JSON, answering `undefined` for text that is not JSON so the schema
 * check reports it.
 *
 * @param text - The body text.
 * @returns The parsed value, or undefined.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
