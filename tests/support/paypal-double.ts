import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll } from "vitest";

import { fromPayPalValue, toPayPalValue } from "@/money/paypal-value";
import { createPayPalClient, type PayPalClient } from "@/paypal/client";

import { paypalFixture } from "./fixtures";
import { recordedAnswer } from "./recorded";

/*
 * A stateful stand-in for PayPal's Orders and Payments APIs, answering in
 * the shapes the sandbox answered U0 with on 12 October 2026 (the recorded
 * answers are its templates) and keeping the rules U0 observed:
 *
 * - an order is authorised only once the owner has approved it;
 * - a capture never exceeds what is left of its authorisation; a final
 *   capture below it leaves the authorisation `CAPTURED` (P2), a non-final
 *   one `PARTIALLY_CAPTURED` (P3);
 * - a void after a capture succeeds and leaves the authorisation `VOIDED`
 *   with its original amount (P4); a void of a captured authorisation is
 *   refused `PREVIOUSLY_CAPTURED` (PayPal's documented sample);
 * - a reauthorisation inside three days is refused `REAUTHORIZATION_TOO_SOON`
 *   (P5 (a)), and from day 4 answers a new authorisation (the documented
 *   sample's shape); a card authorisation's is refused (the API documents it
 *   for PayPal accounts; the issue name is this double's, P5 (c) is owed);
 * - `PayPal-Mock-Response` `AUTHORIZATION_EXPIRED` on a capture is refused as
 *   P5 (a) recorded it;
 * - a POST with a `PayPal-Request-Id` already answered with a success is
 *   answered the same again and acts once.
 */

const TOKEN = paypalFixture("api/oauth-token.json");
const DAY_MS = 24 * 60 * 60 * 1000;

/** One request the double received. */
export interface DoubleRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: unknown;
}

/** An order the double holds. */
export interface DoubleOrder {
  readonly id: string;
  readonly amountPence: number;
  readonly currency: string;
  readonly referenceId: string;
  readonly customId: string;
  readonly items: unknown;
  approvedWith: "paypal" | "card" | null;
  authorizationId: string | null;
}

/** An authorisation the double holds. */
export interface DoubleAuthorization {
  readonly id: string;
  readonly orderId: string;
  readonly amountPence: number;
  readonly currency: string;
  readonly kind: "paypal" | "card";
  readonly createdAt: Date;
  readonly expiresAt: Date;
  status: "CREATED" | "PARTIALLY_CAPTURED" | "CAPTURED" | "VOIDED";
  capturedPence: number;
  reauthorisedAs: string | null;
}

/** A capture the double holds. */
export interface DoubleCapture {
  readonly id: string;
  readonly authorizationId: string;
  readonly amountPence: number;
  readonly finalCapture: boolean;
  refundedPence: number;
}

/** A one-off answer that replaces the double's own for the next matching request. */
export interface InjectedAnswer {
  readonly method: string;
  readonly path: RegExp;
  readonly status: number;
  readonly body: unknown;
  /** Whether the request still acts at PayPal (an answer lost on the way back). */
  readonly acts?: boolean;
}

/** The double, for the calling test file. */
export interface PayPalDouble {
  readonly client: () => PayPalClient;
  readonly requests: DoubleRequest[];
  readonly orders: Map<string, DoubleOrder>;
  readonly authorizations: Map<string, DoubleAuthorization>;
  readonly captures: Map<string, DoubleCapture>;
  /** PayPal's clock. */
  readonly clock: { now: Date };
  /** The owner approves an order on PayPal's page, by wallet or card. */
  approve(orderId: string, kind?: "paypal" | "card"): void;
  /** Answers the next matching request with this instead. */
  inject(answer: InjectedAnswer): void;
  /** The POSTs received, by path pattern. */
  posts(path: RegExp): DoubleRequest[];
}

/**
 * An id of PayPal's shape: seventeen upper-case letters and digits.
 *
 * @returns The id.
 */
function paypalId(): string {
  const alphabet = "ABCDEFGHJKLMNPRSTUVWXY0123456789";
  return [...randomBytes(17)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * A deep copy of a recorded answer, as a template.
 *
 * @param value - The answer.
 * @returns The copy.
 */
function template<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Starts the double for the calling test file; its state and requests reset
 * after each test.
 *
 * @returns The double.
 */
export function startPayPalDouble(): PayPalDouble {
  const requests: DoubleRequest[] = [];
  const orders = new Map<string, DoubleOrder>();
  const authorizations = new Map<string, DoubleAuthorization>();
  const captures = new Map<string, DoubleCapture>();
  const answered = new Map<string, { status: number; body: unknown }>();
  const injected: InjectedAnswer[] = [];
  const clock = { now: new Date("2026-10-13T09:00:00Z") };
  let address: AddressInfo | undefined;

  const amount = (pence: number, currency: string) => ({
    currency_code: currency,
    value: toPayPalValue(pence),
  });

  const unprocessable = (issue: string, description: string) => ({
    status: 422,
    body: {
      name: "UNPROCESSABLE_ENTITY",
      message:
        "The requested action could not be performed, semantically incorrect, or failed business validation.",
      debug_id: "double422",
      details: [{ issue, description }],
    },
  });

  const authorizationBody = (held: DoubleAuthorization, localOffset = false) => {
    const body = template(
      recordedAnswer("P2", "GET", /^\/v2\/payments\/authorizations\//).responseBody,
    ) as Record<string, unknown>;
    const time = (at: Date) =>
      localOffset
        ? new Date(at.getTime() - 7 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "-07:00")
        : at.toISOString().replace(/\.\d+Z$/, "Z");
    Object.assign(body, {
      id: held.id,
      status: held.status,
      amount: amount(held.amountPence, held.currency),
      custom_id: orders.get(held.orderId)?.customId,
      supplementary_data: { related_ids: { order_id: held.orderId } },
      expiration_time: time(held.expiresAt),
      create_time: time(held.createdAt),
      update_time: time(clock.now),
      links: [
        {
          href: `https://api.sandbox.paypal.com/v2/payments/authorizations/${held.id}`,
          rel: "self",
          method: "GET",
        },
      ],
    });
    return body;
  };

  const orderBody = (made: DoubleOrder) => {
    if (made.authorizationId) {
      const body = template(
        recordedAnswer(made.approvedWith === "card" ? "P6" : "P1", "POST", /\/authorize$/)
          .responseBody,
      ) as Record<string, unknown> & { purchase_units: Record<string, unknown>[] };
      body.id = made.id;
      body.status = "COMPLETED";
      body.purchase_units[0] = {
        ...body.purchase_units[0],
        reference_id: made.referenceId,
        custom_id: made.customId,
        amount: amount(made.amountPence, made.currency),
        payments: {
          authorizations: [authorizationBody(authorizations.get(made.authorizationId)!)],
        },
      };
      return body;
    }
    const body = template(
      recordedAnswer("P1", "POST", /^\/v2\/checkout\/orders$/).responseBody,
    ) as Record<string, unknown> & { purchase_units: Record<string, unknown>[] };
    body.id = made.id;
    body.status = made.approvedWith ? "APPROVED" : "PAYER_ACTION_REQUIRED";
    body.purchase_units[0] = {
      ...body.purchase_units[0],
      reference_id: made.referenceId,
      custom_id: made.customId,
      amount: amount(made.amountPence, made.currency),
    };
    body.links = [
      {
        href: `https://api.sandbox.paypal.com/v2/checkout/orders/${made.id}`,
        rel: "self",
        method: "GET",
      },
      {
        href: `https://www.sandbox.paypal.com/checkoutnow?token=${made.id}`,
        rel: "payer-action",
        method: "GET",
      },
    ];
    return body;
  };

  const captureBody = (taken: DoubleCapture, currency: string) => {
    const body = template(recordedAnswer("P2", "POST", /\/capture$/).responseBody) as Record<
      string,
      unknown
    >;
    const fee = Math.round(taken.amountPence * 0.034) + 20;
    Object.assign(body, {
      id: taken.id,
      status:
        taken.refundedPence === 0
          ? "COMPLETED"
          : taken.refundedPence < taken.amountPence
            ? "PARTIALLY_REFUNDED"
            : "REFUNDED",
      amount: amount(taken.amountPence, currency),
      final_capture: taken.finalCapture,
      seller_receivable_breakdown: {
        gross_amount: amount(taken.amountPence, currency),
        paypal_fee: amount(fee, currency),
        net_amount: amount(taken.amountPence - fee, currency),
      },
      create_time: clock.now.toISOString().replace(/\.\d+Z$/, "Z"),
      update_time: clock.now.toISOString().replace(/\.\d+Z$/, "Z"),
    });
    return body;
  };

  const act = (request: DoubleRequest): { status: number; body: unknown } => {
    const { method, path } = request;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (method === "POST" && path === "/v1/oauth2/token") {
      return { status: 200, body: TOKEN };
    }
    if (method === "POST" && path === "/v2/checkout/orders") {
      const unit = (body.purchase_units as Record<string, unknown>[])[0]!;
      const value = unit.amount as { currency_code: string; value: string };
      const made: DoubleOrder = {
        id: paypalId(),
        amountPence: fromPayPalValue(value.value),
        currency: value.currency_code,
        referenceId: String(unit.reference_id),
        customId: String(unit.custom_id),
        items: unit.items ?? null,
        approvedWith: null,
        authorizationId: null,
      };
      orders.set(made.id, made);
      return { status: 200, body: orderBody(made) };
    }
    let match = /^\/v2\/checkout\/orders\/([^/]+)(\/authorize)?$/.exec(path);
    if (match) {
      const made = orders.get(match[1]!);
      if (!made) {
        return { status: 404, body: { name: "RESOURCE_NOT_FOUND", debug_id: "double404" } };
      }
      if (method === "GET") {
        return { status: 200, body: orderBody(made) };
      }
      if (!made.approvedWith) {
        return unprocessable(
          "ORDER_NOT_APPROVED",
          "Payer has not yet approved the Order for payment.",
        );
      }
      if (!made.authorizationId) {
        const held: DoubleAuthorization = {
          id: paypalId(),
          orderId: made.id,
          amountPence: made.amountPence,
          currency: made.currency,
          kind: made.approvedWith,
          createdAt: clock.now,
          expiresAt: new Date(clock.now.getTime() + 29 * DAY_MS),
          status: "CREATED",
          capturedPence: 0,
          reauthorisedAs: null,
        };
        authorizations.set(held.id, held);
        made.authorizationId = held.id;
      }
      return { status: 201, body: orderBody(made) };
    }
    match = /^\/v2\/payments\/authorizations\/([^/]+)(\/[a-z]+)?$/.exec(path);
    if (match) {
      const held = authorizations.get(match[1]!);
      if (!held) {
        return { status: 404, body: { name: "RESOURCE_NOT_FOUND", debug_id: "double404" } };
      }
      const action = match[2];
      if (method === "GET" && !action) {
        return { status: 200, body: authorizationBody(held) };
      }
      if (action === "/capture") {
        if (
          String(request.headers["paypal-mock-response"] ?? "").includes("AUTHORIZATION_EXPIRED")
        ) {
          return { status: 422, body: recordedAnswer("P5A", "POST", /\/capture$/).responseBody };
        }
        if (held.status === "CAPTURED") {
          return unprocessable(
            "AUTHORIZATION_ALREADY_CAPTURED",
            "Authorization has been previously captured.",
          );
        }
        if (held.status === "VOIDED") {
          return unprocessable(
            "AUTHORIZATION_VOIDED",
            "A voided authorization cannot be captured.",
          );
        }
        const asked = body.amount as { value: string } | undefined;
        const left = held.amountPence - held.capturedPence;
        const taking = asked ? fromPayPalValue(asked.value) : left;
        if (taking > left) {
          return {
            status: 422,
            body: {
              ...unprocessable(
                "MAX_CAPTURE_AMOUNT_EXCEEDED",
                "Capture amount specified exceeded allowable limit.",
              ).body,
            },
          };
        }
        const taken: DoubleCapture = {
          id: paypalId(),
          authorizationId: held.id,
          amountPence: taking,
          finalCapture: body.final_capture === true,
          refundedPence: 0,
        };
        captures.set(taken.id, taken);
        held.capturedPence += taking;
        held.status =
          taken.finalCapture || held.capturedPence === held.amountPence
            ? "CAPTURED"
            : "PARTIALLY_CAPTURED";
        return { status: 201, body: captureBody(taken, held.currency) };
      }
      if (action === "/void") {
        if (held.status === "CAPTURED") {
          return { status: 422, body: paypalFixture("api/void-422-previously-captured.json") };
        }
        if (held.status === "VOIDED") {
          return unprocessable("AUTHORIZATION_VOIDED", "The authorization has been voided.");
        }
        held.status = "VOIDED";
        return { status: 200, body: authorizationBody(held, true) };
      }
      if (action === "/reauthorize") {
        if (clock.now.getTime() - held.createdAt.getTime() < 3 * DAY_MS) {
          return {
            status: 422,
            body: recordedAnswer("P5A", "POST", /\/reauthorize$/).responseBody,
          };
        }
        if (held.kind === "card" || held.reauthorisedAs || held.status !== "CREATED") {
          return unprocessable(
            "REAUTHORIZE_NOT_ALLOWED",
            "This authorization cannot be reauthorized (the double's answer; P5 (b) and (c) are owed).",
          );
        }
        const renewed: DoubleAuthorization = {
          ...held,
          id: paypalId(),
          createdAt: clock.now,
          status: "CREATED",
          capturedPence: 0,
          reauthorisedAs: null,
        };
        authorizations.set(renewed.id, renewed);
        held.reauthorisedAs = renewed.id;
        const answer = template(paypalFixture("api/reauthorize-201.json")) as Record<
          string,
          unknown
        >;
        answer.id = renewed.id;
        answer.links = [
          {
            rel: "self",
            method: "GET",
            href: `https://api.sandbox.paypal.com/v2/payments/authorizations/${renewed.id}`,
          },
        ];
        return { status: 201, body: answer };
      }
    }
    match = /^\/v2\/payments\/captures\/([^/]+)(\/refund)?$/.exec(path);
    if (match) {
      const taken = captures.get(match[1]!);
      if (!taken) {
        return { status: 404, body: { name: "RESOURCE_NOT_FOUND", debug_id: "double404" } };
      }
      const currency = authorizations.get(taken.authorizationId)!.currency;
      if (method === "GET") {
        return { status: 200, body: captureBody(taken, currency) };
      }
      const asked = body.amount as { value: string } | undefined;
      const left = taken.amountPence - taken.refundedPence;
      const returning = asked ? fromPayPalValue(asked.value) : left;
      if (returning > left || returning === 0) {
        return { status: 422, body: paypalFixture("api/refund-422-amount-exceeded.json") };
      }
      taken.refundedPence += returning;
      const answer = template(paypalFixture("api/refund-201.json")) as Record<string, unknown>;
      Object.assign(answer, {
        id: paypalId(),
        amount: amount(returning, currency),
        create_time: clock.now.toISOString().replace(/\.\d+Z$/, "Z"),
      });
      return { status: 201, body: answer };
    }
    return { status: 404, body: { name: "RESOURCE_NOT_FOUND", debug_id: "double404" } };
  };

  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown = null;
      try {
        parsed =
          text.length > 0 && !text.startsWith("grant_type") ? (JSON.parse(text) as unknown) : null;
      } catch {
        parsed = null;
      }
      const request: DoubleRequest = {
        method: incoming.method ?? "GET",
        path: (incoming.url ?? "/").split("?")[0]!,
        headers: incoming.headers,
        body: parsed,
      };
      requests.push(request);
      const requestId = incoming.headers["paypal-request-id"];
      const key = typeof requestId === "string" ? `${request.path} ${requestId}` : null;
      // An injected answer wins; else a request id already answered with a
      // success is answered the same again (PayPal documents its idempotent
      // replay for successes; whether it replays refusals is unverified, so
      // the double does not).
      const at = injected.findIndex(
        (one) => one.method === request.method && one.path.test(request.path),
      );
      let answer: { status: number; body: unknown };
      if (at >= 0) {
        const [one] = injected.splice(at, 1);
        if (one!.acts) {
          const acted = (key ? answered.get(key) : undefined) ?? act(request);
          if (key && acted.status >= 200 && acted.status < 300) {
            answered.set(key, acted);
          }
        }
        answer = { status: one!.status, body: one!.body };
      } else {
        answer = (key ? answered.get(key) : undefined) ?? act(request);
        if (key && answer.status >= 200 && answer.status < 300) {
          answered.set(key, answer);
        }
      }
      outgoing.writeHead(answer.status, { "content-type": "application/json" });
      outgoing.end(answer.body === null ? "" : JSON.stringify(answer.body));
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = server.address() as AddressInfo;
  });
  afterEach(() => {
    requests.length = 0;
    orders.clear();
    authorizations.clear();
    captures.clear();
    answered.clear();
    injected.length = 0;
    clock.now = new Date("2026-10-13T09:00:00Z");
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  return {
    client: () => {
      if (!address) {
        throw new Error("the PayPal double is not listening yet");
      }
      return createPayPalClient({
        clientId: "FAKE-CLIENT-ID",
        clientSecret: "FAKE-CLIENT-SECRET",
        environment: "sandbox",
        baseUrl: `http://127.0.0.1:${address.port}`,
        timeoutMs: 5_000,
      });
    },
    requests,
    orders,
    authorizations,
    captures,
    clock,
    approve: (orderId, kind = "paypal") => {
      const made = orders.get(orderId);
      if (!made) {
        throw new Error(`the double holds no order ${orderId}`);
      }
      made.approvedWith = kind;
    },
    inject: (answer) => {
      injected.push(answer);
    },
    posts: (path) =>
      requests.filter((request) => request.method === "POST" && path.test(request.path)),
  };
}
