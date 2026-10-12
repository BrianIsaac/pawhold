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
  /** P8 only: the webhook id of the deployed listener's subscription. */
  PAYPAL_WEBHOOK_ID: z
    .string()
    .max(50)
    .regex(/^[A-Za-z0-9]+$/)
    .optional(),
  /** P8 only: the deployed database the listener writes to. */
  P8_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
});

export type ProbeEnvironment = z.infer<typeof probeEnvironment>;

/**
 * The values that must never reach the report, a recording or a log: the
 * credentials, the logins, P8's webhook id, and the database URL whole and
 * by its parts (a driver's error names the host or the user alone).
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
    ...(env.PAYPAL_WEBHOOK_ID ? [env.PAYPAL_WEBHOOK_ID] : []),
    ...(env.P8_DATABASE_URL ? databaseUrlParts(env.P8_DATABASE_URL) : []),
  ];
}

/**
 * A database URL and the parts of it that identify the database.
 *
 * @param value - The URL.
 * @returns The URL, its host, its user and its password.
 */
function databaseUrlParts(value: string): string[] {
  const url = new URL(value);
  return [
    value,
    url.hostname,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
  ].filter((part) => part.length > 0);
}
