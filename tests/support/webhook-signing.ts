import { execFileSync } from "node:child_process";
import { createPrivateKey, randomUUID, sign, X509Certificate, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

/** A signing key and its self-signed certificate, made for one test file. */
export interface TestSigner {
  readonly certificate: X509Certificate;
  readonly certificatePem: string;
  /**
   * Signs a delivery as PayPal's "Integrate webhooks" page describes and
   * returns the headers PayPal would send with it.
   */
  readonly headersFor: (body: string | Buffer, options: SignOptions) => Record<string, string>;
}

/** What a signed delivery's headers carry. */
export interface SignOptions {
  readonly webhookId: string;
  readonly certUrl?: string;
  readonly transmissionId?: string;
  readonly transmissionTime?: string;
  readonly authAlgo?: string;
}

export const SANDBOX_CERT_URL =
  "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d";

/**
 * Generates an RSA key and a self-signed certificate with `openssl`, standing
 * in for PayPal's signing certificate. Nothing is fetched from PayPal.
 *
 * @returns The signer.
 */
export function createTestSigner(): TestSigner {
  const directory = mkdtempSync(join(tmpdir(), "pawhold-signer-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=pawhold test signer, not PayPal",
      ],
      { stdio: "ignore" },
    );
    const key: KeyObject = createPrivateKey(readFileSync(join(directory, "key.pem")));
    const certificatePem = readFileSync(join(directory, "cert.pem"), "utf8");
    return {
      certificate: new X509Certificate(certificatePem),
      certificatePem,
      headersFor: (body, options) => {
        const transmissionId = options.transmissionId ?? randomUUID();
        const transmissionTime = options.transmissionTime ?? new Date().toISOString();
        const message = `${transmissionId}|${transmissionTime}|${options.webhookId}|${crc32(body)}`;
        return {
          "content-type": "application/json",
          "paypal-transmission-id": transmissionId,
          "paypal-transmission-time": transmissionTime,
          "paypal-transmission-sig": sign("sha256", Buffer.from(message), key).toString("base64"),
          "paypal-cert-url": options.certUrl ?? SANDBOX_CERT_URL,
          "paypal-auth-algo": options.authAlgo ?? "SHA256withRSA",
        };
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
