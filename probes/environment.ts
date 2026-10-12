import { z } from "zod";

/**
 * What the probes read from their process's environment (never from a file
 * in the tree): the sandbox app's credentials and the GB pair's logins.
 */
export const probeEnvironment = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_SANDBOX_BUSINESS_EMAIL: z.email(),
  PAYPAL_SANDBOX_BUYER_EMAIL: z.email(),
  PAYPAL_SANDBOX_BUYER_PASSWORD: z.string().min(1),
  /** P8 only: the deployed database the listener writes to. */
  P8_DATABASE_URL: z.string().min(1).optional(),
});

export type ProbeEnvironment = z.infer<typeof probeEnvironment>;

/**
 * The values that must never reach the report, a recording or a log.
 *
 * @param env - The probes' environment.
 * @returns The values.
 */
export function secretsOf(env: ProbeEnvironment): string[] {
  return [
    env.PAYPAL_CLIENT_ID,
    env.PAYPAL_CLIENT_SECRET,
    env.PAYPAL_SANDBOX_BUSINESS_EMAIL,
    env.PAYPAL_SANDBOX_BUYER_EMAIL,
    env.PAYPAL_SANDBOX_BUYER_PASSWORD,
    ...(env.P8_DATABASE_URL ? [env.P8_DATABASE_URL] : []),
  ];
}
