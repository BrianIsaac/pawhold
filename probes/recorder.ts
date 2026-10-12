import { redact } from "./redact";

/** One request to PayPal and its answer, as the report and the recordings keep it. */
export interface Exchange {
  /** When the request was sent, ISO 8601 in UTC with milliseconds. */
  readonly at: string;
  /** How long PayPal took to answer, in milliseconds. */
  readonly ms: number;
  readonly method: string;
  /** The path and query, without the host. */
  readonly path: string;
  /** The `PayPal-Request-Id` sent, if any. */
  readonly requestId: string | null;
  /** Extra headers that change PayPal's behaviour (`Prefer`, `PayPal-Mock-Response`). */
  readonly sentHeaders: Readonly<Record<string, string>>;
  /** The JSON body sent, redacted; null for none and for the token call. */
  readonly requestBody: unknown;
  /** The HTTP status, or null when no answer came. */
  readonly status: number | null;
  /** PayPal's `Paypal-Debug-Id` header, or the error body's `debug_id`. */
  readonly debugId: string | null;
  /** PayPal's JSON answer, redacted; null for an empty body and for the token call. */
  readonly responseBody: unknown;
}

const TOKEN_PATH = "/v1/oauth2/token";

/** Request headers worth keeping: they change what PayPal does. */
const KEPT_HEADERS = ["prefer", "paypal-mock-response"];

/**
 * Wraps a fetch so that every PayPal exchange is appended to `log`, redacted.
 * The token call is logged by status and debug id only: neither its form
 * body nor its answer (the access token) is kept, and no request header but
 * those of `KEPT_HEADERS` is read, so the Authorization header never is.
 *
 * @param base - The fetch that reaches PayPal.
 * @param log - Where exchanges are appended, in the order they were sent.
 * @param now - The clock, in milliseconds since the epoch.
 * @returns The wrapping fetch.
 */
export function recordingFetch(
  base: typeof fetch,
  log: Exchange[],
  now: () => number = Date.now,
): typeof fetch {
  return async (input, init) => {
    const sentAt = now();
    const sent = { at: new Date(sentAt).toISOString(), ...describeRequest(input, init) };
    let answer: Response;
    try {
      answer = await base(input, init);
    } catch (error) {
      log.push({ ...sent, ms: now() - sentAt, status: null, debugId: null, responseBody: null });
      throw error;
    }
    const isToken = sent.path === TOKEN_PATH;
    const text = isToken ? "" : await answer.clone().text();
    const body = text.length === 0 ? null : safeJson(text);
    log.push({
      ...sent,
      ms: now() - sentAt,
      status: answer.status,
      debugId: answer.headers.get("paypal-debug-id") ?? bodyDebugId(body),
      responseBody: isToken ? null : redact(body),
    });
    return answer;
  };
}

/** What the probes keep of a request. */
export type RequestRecord = Pick<
  Exchange,
  "method" | "path" | "requestId" | "sentHeaders" | "requestBody"
>;

/**
 * What the probes keep of a request: its method and path, its
 * `PayPal-Request-Id`, the headers that change PayPal's behaviour and its
 * JSON body, redacted (none for the token call).
 *
 * @param input - fetch's input.
 * @param init - fetch's init.
 * @returns The record.
 */
export function describeRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): RequestRecord {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init?.headers);
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    path: `${url.pathname}${url.search}`,
    requestId: headers.get("paypal-request-id"),
    sentHeaders: Object.fromEntries(
      KEPT_HEADERS.flatMap((name) => {
        const value = headers.get(name);
        return value === null ? [] : [[name, value]];
      }),
    ),
    requestBody: url.pathname === TOKEN_PATH ? null : parseBody(init?.body),
  };
}

/**
 * Parses a request body sent as a JSON string.
 *
 * @param body - The body passed to fetch.
 * @returns The redacted JSON, or null.
 */
function parseBody(body: RequestInit["body"]): unknown {
  return typeof body === "string" && body.length > 0 ? redact(safeJson(body)) : null;
}

/**
 * Parses JSON, keeping non-JSON text as a string.
 *
 * @param text - The text.
 * @returns The parsed value, or the text.
 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * The `debug_id` of an error body.
 *
 * @param body - The parsed body.
 * @returns The id, or null.
 */
function bodyDebugId(body: unknown): string | null {
  if (body !== null && typeof body === "object" && "debug_id" in body) {
    const id = (body as { debug_id: unknown }).debug_id;
    return typeof id === "string" ? id : null;
  }
  return null;
}
