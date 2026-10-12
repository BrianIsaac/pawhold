import { verify as verifySignature, X509Certificate } from "node:crypto";
import { crc32 } from "node:zlib";

import { z } from "zod";

import type { PayPalClient } from "./client";

/**
 * The webhook id PayPal's simulator signs mock events with ("Integrate
 * webhooks": "the ID of mock webhooks is the string: `WEBHOOK_ID`").
 */
export const MOCK_WEBHOOK_ID = "WEBHOOK_ID";

/** The one signing algorithm PayPal's guide and its verify endpoint name. */
export const PAYPAL_AUTH_ALGO = "SHA256withRSA";

/**
 * PayPal's API hosts. A `paypal-cert-url` must be HTTPS on one of these,
 * under `/v1/notifications/certs/`. The guide's example uses
 * `api.sandbox.paypal.com`; which host the simulator uses is for U0 to read.
 */
export const PAYPAL_CERTIFICATE_HOSTS: ReadonlySet<string> = new Set([
  "api.paypal.com",
  "api-m.paypal.com",
  "api.sandbox.paypal.com",
  "api-m.sandbox.paypal.com",
]);

const CERTIFICATE_PATH_PREFIX = "/v1/notifications/certs/";
const MAX_CERTIFICATE_BYTES = 64 * 1024;
const DEFAULT_CERTIFICATE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CERTIFICATE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CERTIFICATES = 16;
const VERIFY_PATH = "/v1/notifications/verify-webhook-signature";

/**
 * PayPal's transmission headers, bounded as the verify endpoint's schema
 * bounds them, except the signature: a 4096-bit key's is 684 characters.
 */
const transmissionHeaders = z.object({
  transmissionId: z.string().min(1).max(50),
  transmissionTime: z.string().min(1).max(100),
  transmissionSig: z.string().min(1).max(1024),
  certUrl: z.string().min(1).max(500),
  authAlgo: z.string().min(1).max(100),
});

export type TransmissionHeaders = z.infer<typeof transmissionHeaders>;

/** Why a delivery was not accepted. */
export type RefusalReason =
  | "headers_invalid"
  | "auth_algo_unsupported"
  | "cert_url_not_paypal"
  | "certificate_refused"
  | "signature_mismatch"
  | "postback_failure"
  | "body_invalid";

/** The verdict on one delivery. */
export type WebhookVerification =
  | {
      readonly outcome: "verified";
      readonly method: "signature" | "postback";
      readonly isMock: boolean;
    }
  | { readonly outcome: "refused"; readonly reason: RefusalReason }
  | {
      readonly outcome: "unavailable";
      readonly reason: "certificate_unavailable" | "postback_unavailable";
    };

/** The certificate could not be had; a retry may succeed. */
export class CertificateUnavailableError extends Error {
  override readonly name = "CertificateUnavailableError";
}

/**
 * PayPal's host has no certificate at the URL (a 4xx, or a body that is not
 * one). A forged delivery names such a URL; it is refused, never posted back.
 */
export class CertificateRefusedError extends Error {
  override readonly name = "CertificateRefusedError";
}

/** Where verification gets the certificate at a `paypal-cert-url`. */
export interface CertificateSource {
  /**
   * Returns the certificate at the URL, which has already been checked as
   * PayPal's.
   *
   * @param url - The certificate URL.
   * @returns The certificate.
   * @throws CertificateUnavailableError when it cannot be had now.
   * @throws CertificateRefusedError when there is no certificate at the URL.
   */
  get(url: URL): Promise<X509Certificate>;
}

/** What one verification needs. */
export interface VerifyWebhookInput {
  /** The body exactly as received; never re-serialised. */
  readonly rawBody: Uint8Array;
  readonly headers: Headers;
  /** The id PayPal gave the subscription to this listener. */
  readonly webhookId: string;
  readonly certificates: CertificateSource;
  /** A client for the verify endpoint, the fallback when no certificate can be had. */
  readonly postback?: PayPalClient;
  /** Also accept the simulator's mock events, signed with `WEBHOOK_ID`. */
  readonly acceptMockEvents?: boolean;
}

/**
 * Reads PayPal's transmission headers from a delivery.
 *
 * @param headers - The delivery's headers.
 * @returns The parsed headers, or null when one is missing or out of bounds.
 */
export function readTransmissionHeaders(headers: Headers): TransmissionHeaders | null {
  const parsed = transmissionHeaders.safeParse({
    transmissionId: headers.get("paypal-transmission-id"),
    transmissionTime: headers.get("paypal-transmission-time"),
    transmissionSig: headers.get("paypal-transmission-sig"),
    certUrl: headers.get("paypal-cert-url"),
    authAlgo: headers.get("paypal-auth-algo"),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Whether a certificate URL is PayPal's: HTTPS, one of PayPal's API hosts on
 * the default port, no credentials, under the certificates path, with no
 * query or fragment (each would be a fresh cache entry and a fresh fetch).
 *
 * @param value - The `paypal-cert-url` header.
 * @returns True when it may be fetched.
 */
export function isPayPalCertificateUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "" &&
    PAYPAL_CERTIFICATE_HOSTS.has(url.hostname) &&
    url.pathname.startsWith(CERTIFICATE_PATH_PREFIX)
  );
}

/**
 * The message PayPal signs: `transmissionId|timeStamp|webhookId|crc32`, the
 * CRC32 of the raw body in decimal ("Integrate webhooks", self verification).
 *
 * @param parts - The transmission id and time from the headers, and the webhook id.
 * @param parts.transmissionId - The `paypal-transmission-id` header.
 * @param parts.transmissionTime - The `paypal-transmission-time` header.
 * @param parts.webhookId - The subscription's webhook id.
 * @param rawBody - The body exactly as received.
 * @returns The signed message.
 */
export function signedMessage(
  parts: { transmissionId: string; transmissionTime: string; webhookId: string },
  rawBody: string | Uint8Array,
): string {
  return `${parts.transmissionId}|${parts.transmissionTime}|${parts.webhookId}|${crc32(rawBody)}`;
}

/**
 * The verify endpoint's request body, with the event spliced in as received:
 * "the webhook_event data be posted back exactly as it was received".
 *
 * @param headers - The delivery's headers.
 * @param webhookId - The subscription's webhook id.
 * @param rawBody - The body exactly as received, as text.
 * @returns The JSON request body.
 * @throws Error when the transmission headers are missing.
 */
export function postbackBody(headers: Headers, webhookId: string, rawBody: string): string {
  const transmission = readTransmissionHeaders(headers);
  if (!transmission) {
    throw new Error("a postback needs PayPal's transmission headers");
  }
  const fields = JSON.stringify({
    transmission_id: transmission.transmissionId,
    transmission_time: transmission.transmissionTime,
    cert_url: transmission.certUrl,
    auth_algo: transmission.authAlgo,
    transmission_sig: transmission.transmissionSig,
    webhook_id: webhookId,
  });
  return `${fields.slice(0, -1)},"webhook_event":${rawBody}}`;
}

const postbackAnswer = z.object({ verification_status: z.enum(["SUCCESS", "FAILURE"]) });

/**
 * Asks PayPal's verify endpoint whether a delivery is genuine. Not usable for
 * the simulator's mock events.
 *
 * @param client - A PayPal client.
 * @param headers - The delivery's headers.
 * @param webhookId - The subscription's webhook id.
 * @param rawBody - The body exactly as received, as text.
 * @returns PayPal's verdict.
 * @throws PayPalError, PayPalTransportError or PayPalContractError when there is none.
 */
export async function verifyByPostback(
  client: PayPalClient,
  headers: Headers,
  webhookId: string,
  rawBody: string,
): Promise<"SUCCESS" | "FAILURE"> {
  const answer = await client.post(VERIFY_PATH, {
    requestId: null,
    rawJsonBody: postbackBody(headers, webhookId, rawBody),
    response: postbackAnswer,
  });
  return answer.body.verification_status;
}

/**
 * Verifies one webhook delivery. Self verification first (the guide's
 * preferred method): the certificate URL checked as PayPal's, the
 * certificate from the cache, the CRC32 message checked against the
 * signature. The postback is the fallback only when the certificate cannot be
 * had; a signature that does not match is refused, never posted back.
 *
 * @param input - The delivery and what verification needs.
 * @returns The verdict.
 */
export async function verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerification> {
  const transmission = readTransmissionHeaders(input.headers);
  if (!transmission) {
    return { outcome: "refused", reason: "headers_invalid" };
  }
  if (transmission.authAlgo !== PAYPAL_AUTH_ALGO) {
    return { outcome: "refused", reason: "auth_algo_unsupported" };
  }
  if (!isPayPalCertificateUrl(transmission.certUrl)) {
    return { outcome: "refused", reason: "cert_url_not_paypal" };
  }

  let certificate: X509Certificate;
  try {
    certificate = await input.certificates.get(new URL(transmission.certUrl));
  } catch (error) {
    if (error instanceof CertificateRefusedError) {
      return { outcome: "refused", reason: "certificate_refused" };
    }
    if (!(error instanceof CertificateUnavailableError)) {
      throw error;
    }
    return postbackFallback(input);
  }

  const signature = Buffer.from(transmission.transmissionSig, "base64");
  const candidates = input.acceptMockEvents
    ? [input.webhookId, MOCK_WEBHOOK_ID]
    : [input.webhookId];
  for (const webhookId of candidates) {
    const message = Buffer.from(signedMessage({ ...transmission, webhookId }, input.rawBody));
    if (signatureMatches(message, certificate, signature)) {
      return { outcome: "verified", method: "signature", isMock: webhookId === MOCK_WEBHOOK_ID };
    }
  }
  return { outcome: "refused", reason: "signature_mismatch" };
}

/**
 * Checks an RSA SHA-256 signature, answering false (never throwing) for a
 * signature or key that cannot be checked.
 *
 * @param message - The signed message.
 * @param certificate - The signer's certificate.
 * @param signature - The signature.
 * @returns True when it matches.
 */
function signatureMatches(
  message: Buffer,
  certificate: X509Certificate,
  signature: Buffer,
): boolean {
  try {
    return verifySignature("sha256", message, certificate.publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * The postback, when self verification could not get its certificate.
 *
 * @param input - The delivery and what verification needs.
 * @returns The verdict.
 */
async function postbackFallback(input: VerifyWebhookInput): Promise<WebhookVerification> {
  if (!input.postback) {
    return { outcome: "unavailable", reason: "certificate_unavailable" };
  }
  const rawText = jsonObjectText(input.rawBody);
  if (rawText === null) {
    return { outcome: "refused", reason: "body_invalid" };
  }
  try {
    const status = await verifyByPostback(input.postback, input.headers, input.webhookId, rawText);
    return status === "SUCCESS"
      ? { outcome: "verified", method: "postback", isMock: false }
      : { outcome: "refused", reason: "postback_failure" };
  } catch {
    return { outcome: "unavailable", reason: "postback_unavailable" };
  }
}

/**
 * The body as text, when it is UTF-8 holding one JSON object: only then is
 * it spliced into the postback, so it cannot add keys of its own to the
 * request PayPal reads under pawhold's token.
 *
 * @param rawBody - The body exactly as received.
 * @returns The text, or null.
 */
function jsonObjectText(rawBody: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody);
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? text : null;
  } catch {
    return null;
  }
}

/** How the certificate cache is built. */
export interface CertificateCacheOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** How long a downloaded certificate is kept before it is fetched again. */
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  /** The most certificates kept; the oldest is dropped past it. */
  readonly maxEntries?: number;
}

/**
 * A certificate source that downloads each certificate once ("This file
 * should automatically be downloaded and cached for future use") and keeps
 * it for a day or until it expires, whichever is sooner. Redirects are
 * refused, so a fetch never leaves the host that was checked; failures are
 * not cached. A 4xx (but 408 and 429) or a body that is not a certificate is
 * a refusal; a network failure, a 5xx, a 408 or 429, or a certificate out of
 * date is "unavailable", for
 * which the postback is the fallback.
 *
 * @param options - Test seams and limits.
 * @returns The source.
 */
export function createCertificateCache(options: CertificateCacheOptions = {}): CertificateSource {
  const fetchImpl = options.fetch ?? fetch;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CERTIFICATES;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_CERTIFICATE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CERTIFICATE_TIMEOUT_MS;
  const entries = new Map<string, { certificate: X509Certificate; keepUntil: number }>();
  const pending = new Map<string, Promise<X509Certificate>>();

  const download = async (url: URL): Promise<X509Certificate> => {
    let answer: Response;
    try {
      answer = await fetchImpl(url.toString(), {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CertificateUnavailableError(`could not fetch ${url.toString()}`, { cause: error });
    }
    if (answer.status !== 200) {
      await answer.body?.cancel();
      const Failure =
        answer.status >= 400 &&
        answer.status < 500 &&
        answer.status !== 408 &&
        answer.status !== 429
          ? CertificateRefusedError
          : CertificateUnavailableError;
      throw new Failure(`${url.toString()} answered ${answer.status}`);
    }
    const pem = await answer.text();
    if (pem.length > MAX_CERTIFICATE_BYTES) {
      throw new CertificateRefusedError(`${url.toString()} is larger than a certificate`);
    }
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(pem);
    } catch (error) {
      throw new CertificateRefusedError(`${url.toString()} is not a certificate`, {
        cause: error,
      });
    }
    const validTo = Date.parse(certificate.validTo);
    if (now() < Date.parse(certificate.validFrom) || now() >= validTo) {
      throw new CertificateUnavailableError(`the certificate at ${url.toString()} is not in date`);
    }
    entries.set(url.toString(), { certificate, keepUntil: Math.min(now() + ttlMs, validTo) });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value!);
    }
    return certificate;
  };

  return {
    get: async (url) => {
      const key = url.toString();
      const entry = entries.get(key);
      if (entry && now() < entry.keepUntil) {
        return entry.certificate;
      }
      entries.delete(key);
      let inFlight = pending.get(key);
      if (!inFlight) {
        inFlight = download(url).finally(() => pending.delete(key));
        pending.set(key, inFlight);
      }
      return inFlight;
    },
  };
}
