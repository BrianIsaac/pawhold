import { z } from "zod";

/** A required environment variable is missing or malformed. */
export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
}

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

export const databaseEnvironment = z.object({
  DATABASE_URL: postgresUrl,
});

export const paypalEnvironment = z.object({
  PAYPAL_ENV: z.literal("sandbox"),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
});

export const webhookEnvironment = z.object({
  PAYPAL_WEBHOOK_ID: z
    .string()
    .max(50)
    .regex(/^[A-Za-z0-9]+$/),
  PAYPAL_ACCEPT_MOCK_WEBHOOKS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export const openaiEnvironment = z.object({
  OPENAI_API_KEY: z.string().min(1),
});

export const sessionEnvironment = z.object({
  SESSION_SECRET: z.string().min(32),
});

/**
 * Reads and validates a group of environment variables. The error names the
 * variables at fault and never their values.
 *
 * @param schema - The variables' schema.
 * @param source - The environment; `process.env` by default.
 * @returns The validated variables.
 * @throws EnvironmentError when one is missing or malformed.
 */
export function readEnvironment<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.output<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new EnvironmentError(`missing or malformed environment: ${names.join(", ")}`);
  }
  return parsed.data;
}
