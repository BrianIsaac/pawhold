/*
 * What the probes keep of PayPal's answers. The report and the recordings
 * carry ids, statuses, amounts and `debug_id`s; never a credential, and
 * never the buyer's or the merchant's personal details (an email address is
 * half of a sandbox login).
 */

export const REDACTED = "<redacted>";

/** Keys whose values are personal details, removed wherever they appear. */
const PERSONAL_KEYS = new Set([
  "email_address",
  "given_name",
  "surname",
  "full_name",
  "national_number",
  "phone_number",
  "birth_date",
  "tax_id",
  "payer_id",
  "account_id",
  "merchant_id",
]);

/** Address fields kept: the country, which P1 reads. */
const ADDRESS_KEPT = new Set(["country_code"]);

/** A credential or personal value reached a record. */
export class SecretLeakError extends Error {
  override readonly name = "SecretLeakError";
}

/**
 * Copies a JSON value with personal details replaced by `<redacted>`: the
 * keys of `PERSONAL_KEYS`, every field of an `address` but its country, and a
 * `name` that is a person's name (an object), not an error's name (a string).
 *
 * @param value - A parsed JSON value.
 * @returns The redacted copy.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (PERSONAL_KEYS.has(key)) {
      out[key] = REDACTED;
    } else if (key === "name" && inner !== null && typeof inner === "object") {
      out[key] = REDACTED;
    } else if (key === "address" && inner !== null && typeof inner === "object") {
      out[key] = Object.fromEntries(
        Object.entries(inner).map(([k, v]) => [k, ADDRESS_KEPT.has(k) ? v : REDACTED]),
      );
    } else {
      out[key] = redact(inner);
    }
  }
  return out;
}

/**
 * Refuses text that holds any of the secrets, case-insensitively, so that a
 * record or a report section is never written with one in it.
 *
 * @param text - The text about to be written.
 * @param secrets - The values that must not appear (credentials, logins).
 * @param where - What the text is, for the error.
 * @returns The text, unchanged.
 * @throws SecretLeakError when a secret appears; the error names no value.
 */
export function assertNoSecrets(text: string, secrets: readonly string[], where: string): string {
  const lower = text.toLowerCase();
  const leaked = secrets.filter((s) => s.length > 0 && lower.includes(s.toLowerCase()));
  if (leaked.length > 0) {
    throw new SecretLeakError(`${where} holds ${leaked.length} secret value(s); not written`);
  }
  return text;
}
