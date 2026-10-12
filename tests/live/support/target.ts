import { z } from "zod";

import type { BuyerLogin } from "../../../probes/buyer";

/*
 * What the live smoke (U10) walks and with what: the deployment's address,
 * or another base URL to prove the check goes red against a dead host; the
 * GB sandbox buyer's login from the repository's secrets; and the health
 * check's answer as `/api/health` gives it.
 */

/** The deployment the smoke walks (plan 7.3, README's "Try it"). */
export const DEPLOYMENT_URL = "https://pawhold.onrender.com";

const baseUrl = z.object({
  PAWHOLD_LIVE_URL: z
    .union([z.literal(""), z.url({ protocol: /^https?$/ })])
    .optional()
    .transform((value) => (value ? value.replace(/\/+$/, "") : DEPLOYMENT_URL))
    .refine((value) => new URL(value).origin === value, "must be an origin, with no path"),
});

const buyer = z.object({
  PAWHOLD_SMOKE_BUYER_EMAIL: z.email(),
  PAWHOLD_SMOKE_BUYER_PASSWORD: z.string().min(1),
});

/** `GET /api/health`'s answer: 200 with the database reached, or 503 (U1). */
export const healthAnswer = z
  .object({
    status: z.enum(["ok", "unavailable"]),
    database: z.enum(["reached", "unreachable", "unconfigured"]),
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
  })
  .strict();

export type HealthAnswer = z.infer<typeof healthAnswer>;

/**
 * The base URL the smoke walks: `PAWHOLD_LIVE_URL` when set and not empty,
 * else the deployment.
 *
 * @param source - The environment; `process.env` by default.
 * @returns The origin, without a trailing slash.
 * @throws Error when `PAWHOLD_LIVE_URL` is not an http or https origin.
 */
export function liveBaseUrl(source: Record<string, string | undefined> = process.env): string {
  const parsed = baseUrl.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `PAWHOLD_LIVE_URL must be an http or https origin: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data.PAWHOLD_LIVE_URL;
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
