/*
 * The probes' fetch retries a request that got no answer (a reset, a
 * timeout, a failed lookup) when sending it again cannot act twice: a GET,
 * the token call, or a POST carrying its `PayPal-Request-Id`, which PayPal
 * answers once per id. An HTTP answer, whatever its status, is never retried,
 * and neither is a request whose own timeout (the client's) has run out.
 */

const TOKEN_PATH = "/v1/oauth2/token";

/** How the retries go. */
export interface RetryOptions {
  /** How many times to send, in all. */
  readonly attempts: number;
  /** The wait before the first retry; doubled before each further one. */
  readonly delayMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Wraps a fetch so that an idempotent request that got no answer is sent again.
 *
 * @param base - The fetch.
 * @param options - Attempts and back-off.
 * @returns The retrying fetch.
 */
export function retryingFetch(base: typeof fetch, options: RetryOptions): typeof fetch {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const idempotent =
      method === "GET" ||
      url.pathname === TOKEN_PATH ||
      new Headers(init?.headers).has("paypal-request-id");
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await base(input, init);
      } catch (error) {
        if (!idempotent || attempt >= options.attempts || init?.signal?.aborted === true) {
          throw error;
        }
        await sleep(options.delayMs * 2 ** (attempt - 1));
      }
    }
  };
}
