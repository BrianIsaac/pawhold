import { z } from "zod";

import type { BuyerLogin } from "../../../probes/buyer";
import { DEPLOYMENT_URL, liveOrigin } from "../../../src/jobs/live-probe";

/*
 * What the live smoke (U10) walks and with what: the deployment's address,
 * or another base URL to prove the check goes red against a dead host; the
 * GB sandbox buyer's login from the repository's secrets; and the health
 * check's answer as `/api/health` gives it.
 */

/** The deployment the smoke walks (plan 7.3, README's "Try it"). */
export { DEPLOYMENT_URL };

const buyer = z.object({
  PAWHOLD_SMOKE_BUYER_EMAIL: z.email(),
  PAWHOLD_SMOKE_BUYER_PASSWORD: z.string().min(1),
});

/**
 * `GET /api/health`'s answer: 200 with the database reached, or 503 (U1).
 * Fields the check does not read are let through, so a new one does not
 * turn the uptime check red.
 */
export const healthAnswer = z.object({
  status: z.enum(["ok", "unavailable"]),
  database: z.enum(["reached", "unreachable", "unconfigured"]),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
});

/** What the health check reports. */
export type HealthAnswer = z.infer<typeof healthAnswer>;

/**
 * The base URL the smoke walks: `PAWHOLD_LIVE_URL` when set and not empty,
 * else the deployment; the origin the hourly job's probe asks (U14).
 *
 * @param source - The environment; `process.env` by default.
 * @returns The origin, without a trailing slash.
 * @throws Error when `PAWHOLD_LIVE_URL` is not an http or https origin.
 */
export function liveBaseUrl(source: Record<string, string | undefined> = process.env): string {
  return liveOrigin(source);
}

/**
 * The GB sandbox buyer's login, from the repository's secrets
 * `PAWHOLD_SMOKE_BUYER_EMAIL` and `PAWHOLD_SMOKE_BUYER_PASSWORD`. A refusal
 * names the variables only, never what they hold.
 *
 * @param source - The environment; `process.env` by default.
 * @returns The login.
 * @throws Error when either is missing or the email is not one.
 */
export function smokeBuyer(source: Record<string, string | undefined> = process.env): BuyerLogin {
  const parsed = buyer.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      "the live walk needs PAWHOLD_SMOKE_BUYER_EMAIL (an email) and PAWHOLD_SMOKE_BUYER_PASSWORD",
    );
  }
  return {
    email: parsed.data.PAWHOLD_SMOKE_BUYER_EMAIL,
    password: parsed.data.PAWHOLD_SMOKE_BUYER_PASSWORD,
  };
}
