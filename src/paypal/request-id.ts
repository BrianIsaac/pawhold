import { createHash } from "node:crypto";

import { z } from "zod";

const requestIdParts = z.strictObject({
  caseId: z.uuid(),
  holdId: z.uuid().optional(),
  step: z
    .string()
    .max(64)
    .regex(
      /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/,
      "a dotted lower-case step, such as capture or refund.2",
    ),
});

export type RequestIdParts = z.input<typeof requestIdParts>;

const DOMAIN = "pawhold.paypal-request-id.v1";

/**
 * Derives the `PayPal-Request-Id` for one money step from the case, the hold
 * and the step (plan 3.2, rule 4), so a retried request carries the same id
 * and PayPal performs it once. The id is a UUID (version 8, RFC 9562) built
 * from a SHA-256 of the parts, the shape PayPal's own example uses.
 *
 * A step that can happen more than once against the same hold (a second
 * refund, say) names its ordinal: `refund.2`.
 *
 * @param parts - The case, the hold (absent before a hold exists) and the step.
 * @returns The request id.
 * @throws ZodError when a part is malformed.
 */
export function paypalRequestId(parts: RequestIdParts): string {
  const { caseId, holdId, step } = requestIdParts.parse(parts);
  const digest = createHash("sha256")
    .update(JSON.stringify([DOMAIN, caseId, holdId ?? null, step]))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
