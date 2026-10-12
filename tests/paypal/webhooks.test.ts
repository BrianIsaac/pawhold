import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createPayPalClient } from "@/paypal/client";
import {
  CertificateUnavailableError,
  createCertificateCache,
  isPayPalCertificateUrl,
  postbackBody,
  signedMessage,
  verifyWebhook,
  type CertificateSource,
} from "@/paypal/webhooks";

import { paypalFixture, paypalFixtureText } from "../support/fixtures";
import { startMockPayPal } from "../support/mock-paypal";
import { createTestSigner, SANDBOX_CERT_URL } from "../support/webhook-signing";

const signer = createTestSigner();
const paypal = startMockPayPal();
const WEBHOOK_ID = "0NH55953DH663215D";
const BODY = paypalFixtureText("webhooks/payment-authorization-created.json");

const certificates: CertificateSource = { get: async () => signer.certificate };

describe("the signed message", () => {
  it("is transmission id, time, webhook id and the body's CRC32 in decimal, joined by bars", () => {
    expect(
      signedMessage({ transmissionId: "t", transmissionTime: "w", webhookId: "h" }, "123456789"),
    ).toBe("t|w|h|3421780262");
  });
});

describe("the certificate URL check", () => {
  it.each([
    SANDBOX_CERT_URL,
    "https://api.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d",
    "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  ])("accepts PayPal's host: %s", (url) => {
    expect(isPayPalCertificateUrl(url)).toBe(true);
  });

  it.each([
    "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com.attacker.example/v1/notifications/certs/CERT-1",
    "https://attacker.example/v1/notifications/certs/CERT-1",
    "https://paypal.com@attacker.example/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com/v1/oauth2/token",
    "not a url",
  ])("refuses one off PayPal's host or path: %s", (url) => {
    expect(isPayPalCertificateUrl(url)).toBe(false);
  });
});

describe("self verification (the CRC32 signature)", () => {
  it("verifies PayPal's documented sample signed for the subscribed webhook id", async () => {
    const headers = new Headers(signer.headersFor(BODY, { webhookId: WEBHOOK_ID }));

    const result = await verifyWebhook({
      rawBody: Buffer.from(BODY),
      headers,
      webhookId: WEBHOOK_ID,
      certificates,
    });

    expect(result).toEqual({ outcome: "verified", method: "signature", isMock: false });
  });

  it("refuses the same body with one byte changed", async () => {
    const headers = new Headers(signer.headersFor(BODY, { webhookId: WEBHOOK_ID }));
    const tampered = Buffer.from(BODY);
    tampered[BODY.indexOf("10.00") + 1] = "9".charCodeAt(0);

    const result = await verifyWebhook({
      rawBody: tampered,
      headers,
      webhookId: WEBHOOK_ID,
      certificates,
    });

    expect(result).toEqual({ outcome: "refused", reason: "signature_mismatch" });
  });

  it("refuses a certificate URL off PayPal's host without fetching it", async () => {
    const get = vi.fn(async () => signer.certificate);
    const headers = new Headers(
      signer.headersFor(BODY, {
        webhookId: WEBHOOK_ID,
        certUrl: "https://attacker.example/v1/notifications/certs/CERT-360caa42",
      }),
    );

    const result = await verifyWebhook({
      rawBody: Buffer.from(BODY),
      headers,
      webhookId: WEBHOOK_ID,
      certificates: { get },
    });

    expect(result).toEqual({ outcome: "refused", reason: "cert_url_not_paypal" });
    expect(get).not.toHaveBeenCalled();
  });

  it("accepts a simulator mock event signed with WEBHOOK_ID only when mock events are allowed", async () => {
    const headers = new Headers(signer.headersFor(BODY, { webhookId: "WEBHOOK_ID" }));
    const input = { rawBody: Buffer.from(BODY), headers, webhookId: WEBHOOK_ID, certificates };

    expect(await verifyWebhook({ ...input, acceptMockEvents: true })).toEqual({
      outcome: "verified",
      method: "signature",
      isMock: true,
    });
    expect(await verifyWebhook(input)).toEqual({
      outcome: "refused",
      reason: "signature_mismatch",
    });
  });

  it("refuses an algorithm other than SHA256withRSA", async () => {
    const headers = new Headers(
      signer.headersFor(BODY, { webhookId: WEBHOOK_ID, authAlgo: "SHA1withRSA" }),
    );

    const result = await verifyWebhook({
      rawBody: Buffer.from(BODY),
      headers,
      webhookId: WEBHOOK_ID,
      certificates,
    });

    expect(result).toEqual({ outcome: "refused", reason: "auth_algo_unsupported" });
  });

  it("refuses a delivery without PayPal's transmission headers", async () => {
    const result = await verifyWebhook({
      rawBody: Buffer.from(BODY),
      headers: new Headers({ "content-type": "application/json" }),
      webhookId: WEBHOOK_ID,
      certificates,
    });

    expect(result).toEqual({ outcome: "refused", reason: "headers_invalid" });
  });
});

describe("the certificate cache", () => {
  it("downloads a certificate once, refusing redirects, and serves it from the cache after", async () => {
    const fetchCertificate = vi.fn(
      async () => new Response(signer.certificatePem, { status: 200 }),
    );
    const cache = createCertificateCache({ fetch: fetchCertificate });

    await cache.get(new URL(SANDBOX_CERT_URL));
    await cache.get(new URL(SANDBOX_CERT_URL));

    expect(fetchCertificate).toHaveBeenCalledTimes(1);
    const [, init] = fetchCertificate.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("error");
  });

  it("does not cache a failed download", async () => {
    const fetchCertificate = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(signer.certificatePem, { status: 200 }));
    const cache = createCertificateCache({ fetch: fetchCertificate });

    await expect(cache.get(new URL(SANDBOX_CERT_URL))).rejects.toBeInstanceOf(
      CertificateUnavailableError,
    );
    await expect(cache.get(new URL(SANDBOX_CERT_URL))).resolves.toBeDefined();
  });

  it("refuses a certificate outside its validity period", async () => {
    const fetchCertificate = vi.fn(
      async () => new Response(signer.certificatePem, { status: 200 }),
    );
    const cache = createCertificateCache({
      fetch: fetchCertificate,
      now: () => Date.now() + 10 * 24 * 60 * 60 * 1000,
    });

    await expect(cache.get(new URL(SANDBOX_CERT_URL))).rejects.toBeInstanceOf(
      CertificateUnavailableError,
    );
  });
});

describe("postback verification (the fallback)", () => {
  const guide = paypalFixture("webhooks/guide-postback-request.json") as Record<string, unknown> & {
    webhook_event: unknown;
  };
  const guideRaw = JSON.stringify(guide.webhook_event);
  const guideHeaders = new Headers({
    "paypal-transmission-id": guide.transmission_id as string,
    "paypal-transmission-time": guide.transmission_time as string,
    "paypal-transmission-sig": guide.transmission_sig as string,
    "paypal-cert-url": guide.cert_url as string,
    "paypal-auth-algo": guide.auth_algo as string,
  });

  it("builds the guide's request body, with the event spliced in byte for byte", () => {
    const body = postbackBody(guideHeaders, guide.webhook_id as string, guideRaw);

    expect(JSON.parse(body)).toEqual(guide);
    expect(body).toContain(`"webhook_event":${guideRaw}}`);
  });

  /**
   * A client pointed at the mock PayPal.
   *
   * @returns The client.
   */
  const client = () =>
    createPayPalClient({
      clientId: "FAKE-CLIENT-ID",
      clientSecret: "FAKE-CLIENT-SECRET-NOT-REAL",
      environment: "sandbox",
      baseUrl: paypal.baseUrl(),
    });
  const unavailable: CertificateSource = {
    get: async () => {
      throw new CertificateUnavailableError("the test's certificate host is down");
    },
  };

  it("falls back to PayPal's verify endpoint when the certificate cannot be had", async () => {
    paypal.on("POST /v1/oauth2/token", {
      status: 200,
      body: paypalFixture("api/oauth-token.json"),
    });
    paypal.on("POST /v1/notifications/verify-webhook-signature", {
      status: 200,
      body: { verification_status: "SUCCESS" },
    });

    const result = await verifyWebhook({
      rawBody: Buffer.from(guideRaw),
      headers: guideHeaders,
      webhookId: WEBHOOK_ID,
      certificates: unavailable,
      postback: client(),
    });

    expect(result).toEqual({ outcome: "verified", method: "postback", isMock: false });
    const sent = paypal.requests.find(
      (r) => r.path === "/v1/notifications/verify-webhook-signature",
    );
    expect(z.object({ webhook_id: z.string() }).parse(JSON.parse(sent!.body)).webhook_id).toBe(
      WEBHOOK_ID,
    );
    expect(sent!.headers["paypal-request-id"]).toBeUndefined();
  });

  it("refuses the delivery when PayPal's verify endpoint answers FAILURE", async () => {
    paypal.on("POST /v1/oauth2/token", {
      status: 200,
      body: paypalFixture("api/oauth-token.json"),
    });
    paypal.on("POST /v1/notifications/verify-webhook-signature", {
      status: 200,
      body: { verification_status: "FAILURE" },
    });

    const result = await verifyWebhook({
      rawBody: Buffer.from(guideRaw),
      headers: guideHeaders,
      webhookId: WEBHOOK_ID,
      certificates: unavailable,
      postback: client(),
    });

    expect(result).toEqual({ outcome: "refused", reason: "postback_failure" });
  });

  it("answers unavailable, so PayPal retries, when neither the certificate nor a postback can be had", async () => {
    const result = await verifyWebhook({
      rawBody: Buffer.from(guideRaw),
      headers: guideHeaders,
      webhookId: WEBHOOK_ID,
      certificates: unavailable,
    });

    expect(result).toEqual({ outcome: "unavailable", reason: "certificate_unavailable" });
  });

  it("never posts a mock event back, since PayPal does not support it", async () => {
    paypal.on("POST /v1/oauth2/token", {
      status: 200,
      body: paypalFixture("api/oauth-token.json"),
    });
    paypal.on("POST /v1/notifications/verify-webhook-signature", {
      status: 200,
      body: { verification_status: "SUCCESS" },
    });

    const result = await verifyWebhook({
      rawBody: Buffer.from(guideRaw),
      headers: guideHeaders,
      webhookId: WEBHOOK_ID,
      certificates: unavailable,
      postback: client(),
      acceptMockEvents: true,
    });

    expect(result).toEqual({ outcome: "verified", method: "postback", isMock: false });
    const sent = paypal.requests.filter(
      (r) => r.path === "/v1/notifications/verify-webhook-signature",
    );
    expect(sent.map((r) => JSON.parse(r.body).webhook_id)).toEqual([WEBHOOK_ID]);
  });
});
