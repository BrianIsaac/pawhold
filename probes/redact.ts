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
  "webhook_id",
]);

/** Address fields kept: the country, which P1 reads. */
const ADDRESS_KEPT = new Set(["country_code"]);

/** A credential or personal value reached a record. */
export class SecretLeakError extends Error {
  override readonly name = "SecretLeakError";
}

/**
 * Copies a JSON value with personal details replaced by `<redacted>`: the
 * keys of `PERSONAL_KEYS`, every field of an `address` (or a `..._address`
 * object such as `billing_address`) but its country, and a `name` that is a
 * person's (an object, or a card holder's), not an error's name (a string).
 *
 * @param value - A parsed JSON value.
 * @returns The redacted copy.
 */
export function redact(value: unknown): unknown {
  return redactUnder(value, null);
}

/**
 * Redacts a value, knowing the key it sits under.
 *
 * @param value - The value.
 * @param parent - The key holding it, or null at the top.
 * @returns The redacted copy.
 */
function redactUnder(value: unknown, parent: string | null): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactUnder(item, parent));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const isObject = inner !== null && typeof inner === "object";
    if (PERSONAL_KEYS.has(key)) {
      out[key] = REDACTED;
    } else if (key === "name" && (isObject || parent === "card")) {
      out[key] = REDACTED;
    } else if ((key === "address" || key.endsWith("_address")) && isObject) {
      out[key] = Object.fromEntries(
        Object.entries(inner).map(([k, v]) => [k, ADDRESS_KEPT.has(k) ? v : REDACTED]),
      );
    } else {
      out[key] = redactUnder(inner, key);
    }
  }
  return out;
}

/**
 * Refuses text that holds any of the secrets, case-insensitively and in
 * their JSON-escaped form too, so that a record or a report section is never
 * written with one in it.
 *
 * @param text - The text about to be written.
 * @param secrets - The values that must not appear (credentials, logins).
 * @param where - What the text is, for the error.
 * @returns The text, unchanged.
 * @throws SecretLeakError when a secret appears; the error names no value.
 */
export function assertNoSecrets(text: string, secrets: readonly string[], where: string): string {
  const lower = text.toLowerCase();
  const leaked = secrets.filter(
    (s) =>
      s.length > 0 &&
      [s, JSON.stringify(s).slice(1, -1)].some((form) => lower.includes(form.toLowerCase())),
  );
  if (leaked.length > 0) {
    throw new SecretLeakError(`${where} holds ${leaked.length} secret value(s); not written`);
  }
  return text;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Removes the secrets (whatever their case) and any email address from text
 * read off a page, before it is kept.
 *
 * @param text - The text.
 * @param secrets - The values to remove.
 * @returns The text without them.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  const withoutSecrets = secrets
    .filter((s) => s.length > 0)
    .reduce(
      (out, s) => out.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), REDACTED),
      text,
    );
  return withoutSecrets.replace(EMAIL, REDACTED);
}
