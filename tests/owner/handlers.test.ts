import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { hold, patientCase } from "@/db/schema";
import { makeEstimateVersion } from "@/estimate/version";
import { sendEstimate } from "@/money/holds";
import { OWNER_LINK_LIFETIME_MS, ownerLink } from "@/owner/link";
import { createOwnerHandlers } from "@/owner/handlers";

import { connectTestDatabase } from "../support/database";
import { DENTAL_LINES, makeDentalCase, type MoneyFixture } from "../support/money";
import { startPayPalDouble } from "../support/paypal-double";

const { db } = connectTestDatabase();
const paypal = startPayPalDouble();

const SECRET = "a-test-secret-that-is-at-least-32-characters-long";
const ORIGIN = "https://pawhold.example";

let fixture: MoneyFixture;
let versionId: string;
let token: string;

beforeEach(async () => {
  fixture = await makeDentalCase(db, "Handler practice");
  const draft = await makeEstimateVersion(db, { ...fixture, actor: "vet", lines: DENTAL_LINES });
  await sendEstimate(db, { practiceId: fixture.practiceId, versionId: draft.id, actor: "vet" });
  versionId = draft.id;
  token = (await ownerLink(db, { ...fixture, versionId }, { secret: SECRET, now: new Date() }))
    .token;
});

/**
 * The handlers on the double, the clock at `now`.
 *
 * @param now - The time the handlers read.
 * @returns The handlers.
 */
function handlers(now: Date = new Date()) {
  return createOwnerHandlers({ db, paypal: () => paypal.client(), secret: SECRET, now: () => now });
}

/**
 * A request to an owner's endpoint from the owner's page.
 *
 * @param path - The endpoint, after `/e/{token}/`.
 * @param init - The method and the body.
 * @param init.method - The method.
 * @param init.body - The JSON body.
 * @param init.origin - The `Origin` header; the page's own by default.
 * @returns The request.
 */
function request(
  path: string,
  init: { method?: string; body?: unknown; origin?: string | null } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.origin !== null) {
    headers.set("origin", init.origin ?? ORIGIN);
  }
  return new Request(`${ORIGIN}/e/${token}/${path}`, {
    method: init.method ?? "POST",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

describe("the owner's order", () => {
  it("makes the hold's PayPal order for the SDK's window, no shipping asked, and answers the same order when asked again", async () => {
    const first = await handlers().order(request("order"), token);
    const again = await handlers().order(request("order"), token);

    expect(first.status).toBe(200);
    const { orderId } = (await first.json()) as { orderId: string };
    expect(((await again.json()) as { orderId: string }).orderId).toBe(orderId);
    const [made] = await db.select().from(hold).where(eq(hold.id, versionId));
    expect(made).toMatchObject({ paypalOrderId: orderId, status: "ordered", amountPence: 77_300 });
    const sent = paypal.posts(/^\/v2\/checkout\/orders$/)[0]!.body as Record<string, unknown>;
    expect(sent.payment_source).toEqual({
      paypal: {
        experience_context: {
          brand_name: "Handler practice",
          locale: "en-GB",
          shipping_preference: "NO_SHIPPING",
          user_action: "CONTINUE",
        },
      },
    });
  });

  it("refuses an expired or changed link, and a request from another site", async () => {
    const expired = await handlers(new Date(Date.now() + OWNER_LINK_LIFETIME_MS)).order(
      request("order"),
      token,
    );
    const changed = await handlers().order(request("order"), `${token.slice(0, -1)}A`);
    const crossSite = await handlers().order(
      request("order", { origin: "https://elsewhere.example" }),
      token,
    );

    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual({ reason: "link_expired" });
    expect(changed.status).toBe(404);
    expect(crossSite.status).toBe(403);
    expect(paypal.posts(/^\/v2\/checkout\/orders$/)).toHaveLength(0);
  });
});

describe("the owner's authorisation", () => {
  it("authorises the approved order and holds the estimate's top", async () => {
    const { orderId } = (await (await handlers().order(request("order"), token)).json()) as {
      orderId: string;
    };
    paypal.approve(orderId, "paypal");

    const answer = await handlers().authorise(request("authorise", { body: { orderId } }), token);

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      status: "authorised",
      paymentKind: "paypal",
      amountPence: 77_300,
      confirmedAt: null,
    });
    const [kase] = await db
      .select({ state: patientCase.moneyState })
      .from(patientCase)
      .where(eq(patientCase.id, fixture.caseId));
    expect(kase!.state).toBe("held");
  });

  it("refuses an order that is not the hold's", async () => {
    await handlers().order(request("order"), token);

    const answer = await handlers().authorise(
      request("authorise", { body: { orderId: "5O190127TN364715T" } }),
      token,
    );

    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ reason: "order_mismatch" });
    expect(paypal.posts(/\/authorize$/)).toHaveLength(0);
  });

  it("refuses a malformed body before anything is asked of PayPal", async () => {
    const answer = await handlers().authorise(
      request("authorise", { body: { orderId: "<script>" } }),
      token,
    );

    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ reason: "request_invalid" });
  });

  it("says PayPal refused when the order was never approved, and holds nothing", async () => {
    const { orderId } = (await (await handlers().order(request("order"), token)).json()) as {
      orderId: string;
    };

    const answer = await handlers().authorise(request("authorise", { body: { orderId } }), token);

    expect(answer.status).toBe(502);
    expect(await answer.json()).toMatchObject({ reason: "paypal_refused" });
    const [kept] = await db.select().from(hold).where(eq(hold.id, versionId));
    expect(kept!.status).toBe("ordered");
  });
});

describe("the owner's hold, as the page polls it", () => {
  it("reads nothing before the order, then the hold, then PayPal's confirmation", async () => {
    const before = await handlers().status(
      request("status", { method: "GET", origin: null }),
      token,
    );
    expect(await before.json()).toEqual({ state: "awaiting_owner", hold: null });

    const { orderId } = (await (await handlers().order(request("order"), token)).json()) as {
      orderId: string;
    };
    paypal.approve(orderId, "card");
    await handlers().authorise(request("authorise", { body: { orderId } }), token);
    const confirmedAt = new Date("2026-10-12T14:02:11.000Z");
    await db.update(hold).set({ confirmedAt }).where(eq(hold.id, versionId));

    const after = await handlers().status(
      request("status", { method: "GET", origin: null }),
      token,
    );

    expect(after.headers.get("cache-control")).toBe("no-store");
    expect(await after.json()).toEqual({
      state: "held",
      hold: {
        status: "authorised",
        paymentKind: "card",
        amountPence: 77_300,
        confirmedAt: confirmedAt.toISOString(),
      },
    });
  });
});
