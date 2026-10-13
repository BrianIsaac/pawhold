import { z } from "zod";

/*
 * The hourly job's probe of the live service (U14): the uptime alert that
 * waits on nobody's scheduler but Render's own cron. It asks the public
 * address, as a judge's browser does, never an internal one; a run that
 * does not find the service healthy exits non-zero, and a failed cron run
 * is Render's email to the operator.
 */

/** The deployment judges use (plan 7.3, README's "Try it"). */
export const DEPLOYMENT_URL = "https://pawhold.onrender.com";

/** The health check's path on the service (`app/api/health/route.ts`). */
const HEALTH_PATH = "/api/health";

/** How long one attempt waits for the whole answer. */
const TIMEOUT_MS = 10_000;

/** How long the probe waits before its one retry, so a single blip is not an outage. */
const RETRY_AFTER_MS = 5_000;

/** How much of a field of a strange body the probe's line repeats. */
const SAID_LIMIT = 40;

/** How much of a failed request's message the probe's line repeats. */
const FAILURE_LIMIT = 80;

const liveEnvironment = z.object({
  PAWHOLD_LIVE_URL: z
    .union([z.literal(""), z.url({ protocol: /^https?$/ })])
    .optional()
    .transform((value) => new URL(value || DEPLOYMENT_URL))
    .refine(
      (url) => url.pathname === "/" && url.search === "" && url.hash === "",
      "must be an origin, with no path, query or fragment",
    )
    .transform((url) => url.origin),
});

/**
 * The health check's answer, as far as the probe reads it. The commit is
 * only repeated in the line, so whatever it is never decides the verdict.
 */
const healthBody = z.object({
  status: z.string(),
  database: z.string(),
  commit: z.unknown().optional(),
});

/** What the probe needs. */
export interface LiveProbeDependencies {
  /** The health check's address (`liveHealthUrl`). */
  readonly url: string;
  /** The fetch to ask with; the platform's by default. */
  readonly fetch?: typeof fetch;
  /** How long one attempt waits for the whole answer. */
  readonly timeoutMs?: number;
  /** How long to wait before the one retry. */
  readonly retryAfterMs?: number;
  /** The wait before the retry; a timer by default. */
  readonly pause?: (ms: number) => Promise<void>;
}

/** What the probe found: the service healthy, or what it saw instead. */
export type LiveProbe =
  | {
      readonly healthy: true;
      readonly url: string;
      readonly attempts: number;
      /** The commit the service reports, or null when it reports none. */
      readonly commit: string | null;
    }
  | {
      readonly healthy: false;
      readonly url: string;
      readonly attempts: number;
      /** What the last attempt saw, in a few words on one line. */
      readonly saw: string;
    };

/** One attempt's finding. */
type Attempt =
  | { readonly healthy: true; readonly commit: string | null }
  | { readonly healthy: false; readonly saw: string };

/**
 * The origin of the live service: `PAWHOLD_LIVE_URL` when that is set and
 * not empty (a bed's or a fork's), else the deployment. The hourly job's
 * probe and the live smoke both read it here.
 *
 * @param source - The environment; `process.env` by default.
 * @returns The origin, without a trailing slash.
 * @throws Error when `PAWHOLD_LIVE_URL` is not an http or https origin.
 */
export function liveOrigin(source: Record<string, string | undefined> = process.env): string {
  const parsed = liveEnvironment.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `PAWHOLD_LIVE_URL must be an http or https origin: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data.PAWHOLD_LIVE_URL;
}

/**
 * The address the probe asks: the live service's health check.
 *
 * @param source - The environment; `process.env` by default.
 * @returns The health check's URL.
 * @throws Error when `PAWHOLD_LIVE_URL` is not an http or https origin.
 */
export function liveHealthUrl(source: Record<string, string | undefined> = process.env): string {
  return `${liveOrigin(source)}${HEALTH_PATH}`;
}

/**
 * Asks the live service's health check, once more after a pause if the first
 * answer is not healthy. Healthy is HTTP 200 with `status: "ok"` and
 * `database: "reached"`; anything else (another status, a timeout, a failed
 * request, a body that is not that JSON) is reported as what was seen. It
 * never throws.
 *
 * @param dependencies - The address, and the limits.
 * @returns What the probe found.
 */
export async function probeLive(dependencies: LiveProbeDependencies): Promise<LiveProbe> {
  const { url } = dependencies;
  const pause =
    dependencies.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ask = (): Promise<Attempt> =>
    attempt(url, dependencies.fetch ?? fetch, dependencies.timeoutMs ?? TIMEOUT_MS);

  let found = await ask();
  let attempts = 1;
  if (!found.healthy) {
    await pause(dependencies.retryAfterMs ?? RETRY_AFTER_MS);
    found = await ask();
    attempts = 2;
  }
  return found.healthy
    ? { healthy: true, url, attempts, commit: found.commit }
    : { healthy: false, url, attempts, saw: found.saw };
}

/**
 * The one line the hourly job logs for a probe.
 *
 * @param probe - What the probe found.
 * @returns The line.
 */
export function describeLiveProbe(probe: LiveProbe): string {
  return probe.healthy
    ? `pawhold: live probe: GET ${probe.url} answered healthy on attempt ${probe.attempts}, commit ${probe.commit ?? "unknown"}`
    : `pawhold: live probe failed: GET ${probe.url} answered ${probe.saw}, after ${probe.attempts} attempts`;
}

/**
 * One bounded request to the health check.
 *
 * @param url - The health check's address.
 * @param ask - The fetch.
 * @param timeoutMs - How long to wait for the whole answer.
 * @returns What the attempt saw.
 */
async function attempt(url: string, ask: typeof fetch, timeoutMs: number): Promise<Attempt> {
  const signal = AbortSignal.timeout(timeoutMs);
  let status: number;
  let text: string;
  try {
    const response = await ask(url, {
      signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    return {
      healthy: false,
      saw: signal.aborted ? `no answer in ${timeoutMs} ms` : failure(error),
    };
  }

  const body = healthBody.safeParse(json(text));
  if (!body.success) {
    return {
      healthy: false,
      saw: `HTTP ${status} with a body that is not the health check's JSON`,
    };
  }
  if (status === 200 && body.data.status === "ok" && body.data.database === "reached") {
    return {
      healthy: true,
      commit: typeof body.data.commit === "string" ? body.data.commit : null,
    };
  }
  return {
    healthy: false,
    saw: `HTTP ${status} with status ${said(body.data.status)} and database ${said(body.data.database)}`,
  };
}

/**
 * A body read as JSON.
 *
 * @param text - The body.
 * @returns What it parses to, or undefined when it is not JSON.
 */
function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A failed request in a few words: fetch's message and the code of what
 * caused it (`ENOTFOUND`, `ECONNREFUSED`), which is where the platform's
 * fetch says why.
 *
 * @param error - What the fetch threw.
 * @returns The words.
 */
function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === "string" ? `: ${cause.code}` : "";
  return `the request failed (${cut(message, FAILURE_LIMIT)}${code})`;
}

/**
 * A field of the answer, quoted, cut short and kept on one line.
 *
 * @param value - The field.
 * @returns The quoted value.
 */
function said(value: string): string {
  return JSON.stringify(cut(value, SAID_LIMIT));
}

/**
 * Words from outside, on one line and no longer than a limit.
 *
 * @param text - The words.
 * @param limit - How many characters to keep.
 * @returns The words, with every run of white space a single space.
 */
function cut(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit)}...` : line;
}
