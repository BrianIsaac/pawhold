import { readFileSync } from "node:fs";

/** One recorded exchange with the sandbox, as U0's recorder kept it. */
export interface RecordedExchange {
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly requestBody: unknown;
  readonly responseBody: unknown;
  readonly debugId: string | null;
}

const RECORDED = new URL("../../probes/recorded/", import.meta.url);

/**
 * The exchanges of a U0 probe's recorded run (run 1, redacted): the sandbox's
 * own answers on 12 October 2026, used as U3's PayPal doubles.
 *
 * @param probe - The probe's id, such as `P2`.
 * @returns Its exchanges, in order.
 */
export function recordedExchanges(probe: string): RecordedExchange[] {
  const run = JSON.parse(readFileSync(new URL(`${probe}.json`, RECORDED), "utf8")) as {
    exchanges: RecordedExchange[];
  };
  return run.exchanges;
}

/**
 * The answers a recorded run got to requests matching a method and a path.
 *
 * @param probe - The probe's id.
 * @param method - The request's method.
 * @param path - A pattern the request's path matches.
 * @returns The matching exchanges, in order.
 */
export function recordedAnswers(probe: string, method: string, path: RegExp): RecordedExchange[] {
  return recordedExchanges(probe).filter(
    (exchange) => exchange.method === method && path.test(exchange.path),
  );
}

/**
 * The single answer a recorded run got to a request, failing when there is
 * not exactly one, so a test never reads the wrong exchange.
 *
 * @param probe - The probe's id.
 * @param method - The request's method.
 * @param path - A pattern the request's path matches.
 * @param index - Which of the matching answers, from 0.
 * @returns The exchange.
 * @throws Error when the recording holds no such answer.
 */
export function recordedAnswer(
  probe: string,
  method: string,
  path: RegExp,
  index = 0,
): RecordedExchange {
  const found = recordedAnswers(probe, method, path)[index];
  if (!found) {
    throw new Error(`${probe} recorded no answer ${index} to ${method} ${String(path)}`);
  }
  return found;
}
