import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { Executor } from "@/db/client";
import { loadEstimateVersion } from "@/estimate/version";

/** How long an owner's link opens the estimate it was sent with. */
export const OWNER_LINK_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

/** The shortest secret a link is signed with: U1's `SESSION_SECRET` bound. */
const MIN_SECRET_LENGTH = 32;

/** The token's layout version, its first byte. */
const LAYOUT = 1;

/**
 * What the signature covers before the payload, so a link's MAC can never be
 * taken for another of the secret's uses (the session cookie signs ids with
 * the same secret).
 */
const DOMAIN = Buffer.from("pawhold owner link v1\0", "utf8");

const UUID_BYTES = 16;
const PAYLOAD_BYTES = 1 + UUID_BYTES + UUID_BYTES + 4;
const MAC_BYTES = 32;
const TOKEN_BYTES = PAYLOAD_BYTES + MAC_BYTES;
const TOKEN_LENGTH = Math.ceil((TOKEN_BYTES * 4) / 3);

const tokenShape = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`));

const mintRequest = z.strictObject({ caseId: z.uuid(), versionId: z.uuid() });

const linkRequest = z.strictObject({
  practiceId: z.uuid(),
  caseId: z.uuid(),
  versionId: z.uuid(),
});

/** Why an owner's link could not be made. */
export type OwnerLinkRefusal = "request_invalid" | "version_not_found" | "version_not_sent";

/** An owner's link refused, with the reason a caller branches on. */
export class OwnerLinkError extends Error {
  override readonly name = "OwnerLinkError";

  /**
   * @param reason - Why, as a stable word.
   * @param message - Why, in words.
   */
  constructor(
    readonly reason: OwnerLinkRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** What an owner's link names: one case and one estimate version sent to its owner. */
export interface OwnerLinkTarget {
  readonly caseId: string;
  readonly versionId: string;
}

/** What a token says once checked. */
export type OwnerLinkCheck =
  | ({ readonly status: "valid"; readonly expiresAt: Date } & OwnerLinkTarget)
  | ({ readonly status: "expired"; readonly expiresAt: Date } & OwnerLinkTarget)
  | { readonly status: "invalid" };

/** A link minted for an owner. */
export interface OwnerLink {
  readonly token: string;
  /** The page's path: `/e/{token}`. */
  readonly path: string;
  readonly expiresAt: Date;
}

/**
 * Mints the token of an owner's link: the case, the version and the expiry,
 * signed with HMAC-SHA256 under the server's secret. No login: holding the
 * link is what lets the owner read the estimate and authorise its hold, for
 * 14 days.
 *
 * @param target - The case and the sent version.
 * @param secret - The server's secret (`SESSION_SECRET`).
 * @param now - When it is minted; the expiry is 14 days on.
 * @returns The token, URL-safe base64 with no padding.
 * @throws OwnerLinkError when an id is not a UUID or the secret is short.
 */
export function mintOwnerToken(target: OwnerLinkTarget, secret: string, now: Date): string {
  const parsed = mintRequest.safeParse(target);
  if (!parsed.success) {
    throw new OwnerLinkError("request_invalid", z.prettifyError(parsed.error));
  }
  requireSecret(secret);
  const expiresAt = Math.floor((now.getTime() + OWNER_LINK_LIFETIME_MS) / 1000);
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  payload.writeUInt8(LAYOUT, 0);
  uuidBytes(parsed.data.caseId).copy(payload, 1);
  uuidBytes(parsed.data.versionId).copy(payload, 1 + UUID_BYTES);
  payload.writeUInt32BE(expiresAt, 1 + 2 * UUID_BYTES);
  return Buffer.concat([payload, mac(payload, secret)]).toString("base64url");
}

/**
 * Checks an owner's link token. A token whose signature holds names its case
 * even once expired, so the page can name the practice to ask; anything else
 * (cut, lengthened, changed, signed under another secret) is invalid and
 * names nothing.
 *
 * @param token - The token from the link's path.
 * @param secret - The server's secret.
 * @param now - The time to check the expiry against.
 * @returns What the token says.
 */
export function verifyOwnerToken(token: string, secret: string, now: Date): OwnerLinkCheck {
  if (!tokenShape.safeParse(token).success || secret.length < MIN_SECRET_LENGTH) {
    return { status: "invalid" };
  }
  const bytes = Buffer.from(token, "base64url");
  // base64url decoding ignores stray trailing bits; re-encoding catches a changed last character.
  if (bytes.length !== TOKEN_BYTES || bytes.toString("base64url") !== token) {
    return { status: "invalid" };
  }
  const payload = bytes.subarray(0, PAYLOAD_BYTES);
  if (!timingSafeEqual(bytes.subarray(PAYLOAD_BYTES), mac(payload, secret))) {
    return { status: "invalid" };
  }
  if (payload.readUInt8(0) !== LAYOUT) {
    return { status: "invalid" };
  }
  const target = {
    caseId: uuidText(payload.subarray(1, 1 + UUID_BYTES)),
    versionId: uuidText(payload.subarray(1 + UUID_BYTES, 1 + 2 * UUID_BYTES)),
  };
  const expiresAt = new Date(payload.readUInt32BE(1 + 2 * UUID_BYTES) * 1000);
  return now.getTime() < expiresAt.getTime()
    ? { status: "valid", ...target, expiresAt }
    : { status: "expired", ...target, expiresAt };
}

/**
 * The owner's link for a version the practice has sent: what U5's send
 * screen and the seed hand the owner.
 *
 * @param executor - The pool or an open transaction.
 * @param request - The practice, the case and the sent version.
 * @param signing - The server's secret and the time of minting.
 * @param signing.secret - The server's secret (`SESSION_SECRET`).
 * @param signing.now - When the link is minted.
 * @returns The link.
 * @throws OwnerLinkError when the practice's case has no such version, or it is still a draft.
 */
export async function ownerLink(
  executor: Executor,
  request: z.input<typeof linkRequest>,
  signing: { readonly secret: string; readonly now: Date },
): Promise<OwnerLink> {
  const parsed = linkRequest.safeParse(request);
  if (!parsed.success) {
    throw new OwnerLinkError("request_invalid", z.prettifyError(parsed.error));
  }
  const { practiceId, caseId, versionId } = parsed.data;
  const version = await loadEstimateVersion(executor, practiceId, versionId);
  if (!version || version.caseId !== caseId) {
    throw new OwnerLinkError(
      "version_not_found",
      `the practice's case ${caseId} has no estimate version ${versionId}`,
    );
  }
  if (version.sentAt === null) {
    throw new OwnerLinkError(
      "version_not_sent",
      `version ${version.number} is a draft: only a sent estimate is linked to its owner`,
    );
  }
  const token = mintOwnerToken({ caseId, versionId }, signing.secret, signing.now);
  const check = verifyOwnerToken(token, signing.secret, signing.now);
  if (check.status !== "valid") {
    throw new OwnerLinkError("request_invalid", "the minted link did not verify");
  }
  return { token, path: `/e/${token}`, expiresAt: check.expiresAt };
}

/**
 * Refuses a secret shorter than U1's bound.
 *
 * @param secret - The secret.
 * @throws OwnerLinkError when it is short.
 */
function requireSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new OwnerLinkError(
      "request_invalid",
      `the link's secret must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
}

/**
 * The signature of a payload.
 *
 * @param payload - The payload.
 * @param secret - The server's secret.
 * @returns The 32-byte MAC.
 */
function mac(payload: Buffer, secret: string): Buffer {
  return createHmac("sha256", secret).update(DOMAIN).update(payload).digest();
}

/**
 * A UUID's 16 bytes.
 *
 * @param uuid - The UUID in its text form.
 * @returns The bytes.
 */
function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

/**
 * A UUID's text form, lower case.
 *
 * @param bytes - Its 16 bytes.
 * @returns The text.
 */
function uuidText(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
