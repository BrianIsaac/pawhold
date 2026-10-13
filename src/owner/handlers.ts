import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client";
import { patientCase } from "@/db/schema";
import { sameOrigin } from "@/judge/session";
import { MoneyError, type MoneyRefusal } from "@/money/errors";
import { authoriseHold, declineUpdate, orderHold } from "@/money/holds";
import { caseHolds, type HoldView } from "@/money/view";
import { loadSourcePhoto } from "@/practice/update";
import type { PayPalClient } from "@/paypal/client";

import { resolveOwnerLink } from "./resolve";

/** What the owner's endpoints need. */
export interface OwnerHandlerDependencies {
  readonly db: Database["db"];
  /** The PayPal client, or null when the sandbox app's credentials are not set. */
  readonly paypal: () => PayPalClient | null;
  /** The server's secret the owner's links are signed with. */
  readonly secret: string;
  readonly now?: () => Date;
}

/** The hold the owner's page shows, as the endpoints answer it. */
export interface OwnerHoldAnswer {
  readonly status: HoldView["status"];
  readonly paymentKind: HoldView["paymentKind"];
  readonly amountPence: number;
  /** When PayPal's webhook confirmed the authorisation, in ISO 8601; null until then. */
  readonly confirmedAt: string | null;
}

/** Why an owner's request was refused, as the page branches on it. */
export type OwnerRefusal =
  | MoneyRefusal
  | "link_expired"
  | "cross_origin"
  | "order_mismatch"
  | "paypal_not_configured"
  | "photo_not_shared";

/** PayPal's order ids: upper-case letters and digits. */
const authoriseBody = z.strictObject({ orderId: z.string().regex(/^[A-Z0-9]{10,40}$/) });

const MONEY_STATUS: Readonly<Record<MoneyRefusal, number>> = {
  request_invalid: 400,
  case_not_found: 404,
  version_not_found: 404,
  hold_not_found: 404,
  capture_not_found: 404,
  wrong_state: 409,
  version_not_awaiting: 409,
  no_increase: 409,
  bill_refused: 409,
  bill_above_holds: 409,
  refund_refused: 409,
  paypal_refused: 502,
  paypal_unavailable: 503,
};

/** The link a request was made under, once resolved. */
interface OpenLink {
  readonly practiceId: string;
  readonly caseId: string;
  readonly versionId: string;
}

/** A hold's statuses the owner's authorise may act on: ordered, or answered again once held. */
const AUTHORISABLE: ReadonlySet<HoldView["status"]> = new Set(["ordered", "authorised"]);

/** PayPal's limit on `brand_name`. */
const MAX_BRAND_NAME = 127;

/**
 * The owner's endpoints under `/e/{token}/`: the order the JS SDK's
 * `createOrder` hands PayPal, the authorisation `onApprove` (or the card
 * fields' submit) asks for, the hold the page polls for PayPal's webhook,
 * and the owner's "Don't go ahead" on an update. The link is the only
 * credential; a POST from another site is refused.
 *
 * @param dependencies - The database, PayPal, the secret and the clock.
 * @returns The handlers, each given the request and the link's token.
 */
export function createOwnerHandlers(dependencies: OwnerHandlerDependencies) {
  const now = dependencies.now ?? (() => new Date());

  /**
   * Resolves the link, or answers why not.
   *
   * @param token - The link's token.
   * @returns The open link, or the refusal.
   */
  const open = async (
    token: string,
  ): Promise<(OpenLink & { readonly practiceName: string }) | Response> => {
    const resolved = await resolveOwnerLink(dependencies.db, token, {
      secret: dependencies.secret,
      now: now(),
    });
    return resolved.kind === "open"
      ? {
          practiceId: resolved.practiceId,
          practiceName: resolved.practiceName,
          caseId: resolved.caseId,
          versionId: resolved.versionId,
        }
      : refuse(404, "link_expired");
  };

  /**
   * The PayPal client, or the answer that there is none.
   *
   * @returns The client, or the refusal.
   */
  const client = (): PayPalClient | Response =>
    dependencies.paypal() ?? refuse(503, "paypal_not_configured");

  return {
    /**
     * `POST /e/{token}/order`: the hold's PayPal order for the estimate the
     * link names, made once and answered again on every ask.
     *
     * @param request - The request.
     * @param token - The link's token.
     * @returns 200 `{ orderId }`, or the refusal.
     */
    order: async (request: Request, token: string): Promise<Response> => {
      if (!sameOrigin(request)) {
        return refuse(403, "cross_origin");
      }
      const link = await open(token);
      if (link instanceof Response) {
        return link;
      }
      const paypal = client();
      if (paypal instanceof Response) {
        return paypal;
      }
      return answering(async () => {
        // PayPal's window for the SDK: the practice's name, no shipping asked
        // (a hold for treatment ships nothing), "Continue" rather than "Pay".
        const ordered = await orderHold(
          { db: dependencies.db, paypal },
          {
            practiceId: link.practiceId,
            caseId: link.caseId,
            versionId: link.versionId,
            experience: { brandName: link.practiceName.slice(0, MAX_BRAND_NAME), locale: "en-GB" },
          },
        );
        return { orderId: ordered.hold.paypalOrderId };
      });
    },

    /**
     * `POST /e/{token}/authorise` with `{ orderId }`: authorises the order
     * the owner approved (U3's `authoriseHold`, idempotent).
     *
     * @param request - The request.
     * @param token - The link's token.
     * @returns 200 with the hold, or the refusal.
     */
    authorise: async (request: Request, token: string): Promise<Response> => {
      if (!sameOrigin(request)) {
        return refuse(403, "cross_origin");
      }
      const body = authoriseBody.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return refuse(400, "request_invalid");
      }
      const link = await open(token);
      if (link instanceof Response) {
        return link;
      }
      const paypal = client();
      if (paypal instanceof Response) {
        return paypal;
      }
      const existing = await linkHold(dependencies.db, link);
      if (!existing || existing.paypalOrderId !== body.data.orderId) {
        return refuse(409, "order_mismatch");
      }
      // A page left open after its estimate was withdrawn, declined or released:
      // PayPal is not asked, so nothing is held only to be voided again.
      if (!AUTHORISABLE.has(existing.status)) {
        return refuse(409, "version_not_awaiting");
      }
      return answering(async () =>
        holdAnswer(
          await authoriseHold(
            { db: dependencies.db, paypal },
            { practiceId: link.practiceId, caseId: link.caseId, holdId: link.versionId },
          ),
        ),
      );
    },

    /**
     * `GET /e/{token}/status`: the case's money state and the link's hold,
     * which the page polls for "Confirmed by PayPal".
     *
     * @param _request - The request.
     * @param token - The link's token.
     * @returns 200 `{ state, hold }`, or the refusal.
     */
    status: async (_request: Request, token: string): Promise<Response> => {
      const link = await open(token);
      if (link instanceof Response) {
        return link;
      }
      const [kase] = await dependencies.db
        .select({ state: patientCase.moneyState })
        .from(patientCase)
        .where(and(eq(patientCase.id, link.caseId), eq(patientCase.practiceId, link.practiceId)));
      const found = await linkHold(dependencies.db, link);
      return answer(200, { state: kase!.state, hold: found ? holdAnswer(found) : null });
    },

    /**
     * `GET /e/{token}/photo`: the photo the vet added to the update the link
     * names, only when they chose "Show the photo to the owner" (section 6).
     * The link is the only credential; never cached, never sniffed (U11).
     *
     * @param _request - The request.
     * @param token - The link's token.
     * @returns The photo, or 404.
     */
    photo: async (_request: Request, token: string): Promise<Response> => {
      const link = await open(token);
      if (link instanceof Response) {
        return link;
      }
      const photo = await loadSourcePhoto(dependencies.db, {
        practiceId: link.practiceId,
        caseId: link.caseId,
        versionId: link.versionId,
      });
      if (!photo?.shared) {
        return refuse(404, "photo_not_shared");
      }
      return new Response(new Uint8Array(photo.bytes), {
        headers: {
          "content-type": photo.mediaType,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": "inline",
        },
      });
    },

    /**
     * `POST /e/{token}/decline`: the owner's "Don't go ahead" on the update
     * the link names; the case stays held at what its holds cover.
     *
     * @param request - The request.
     * @param token - The link's token.
     * @returns 200 `{ state }`, or the refusal.
     */
    decline: async (request: Request, token: string): Promise<Response> => {
      if (!sameOrigin(request)) {
        return refuse(403, "cross_origin");
      }
      const link = await open(token);
      if (link instanceof Response) {
        return link;
      }
      return answering(async () => ({
        state: await declineUpdate(dependencies.db, {
          practiceId: link.practiceId,
          caseId: link.caseId,
          actor: "owner",
          versionId: link.versionId,
        }),
      }));
    },
  };
}

/**
 * The hold a link's version made, if its order was made.
 *
 * @param db - The pool.
 * @param link - The open link.
 * @returns The hold, or null.
 */
async function linkHold(db: Database["db"], link: OpenLink): Promise<HoldView | null> {
  return (await caseHolds(db, link.caseId)).find((one) => one.id === link.versionId) ?? null;
}

/**
 * A hold as the endpoints answer it.
 *
 * @param found - The hold.
 * @returns The answer.
 */
function holdAnswer(found: HoldView): OwnerHoldAnswer {
  return {
    status: found.status,
    paymentKind: found.paymentKind,
    amountPence: found.amount.pence,
    confirmedAt: found.confirmedAt?.toISOString() ?? null,
  };
}

/**
 * Runs a money step and answers it, a refusal by its reason; PayPal's
 * refusal carries its issue names, so the page can tell a card's `failed`
 * from a "no".
 *
 * @param step - The step.
 * @returns 200 with the step's answer, or the refusal.
 */
async function answering(step: () => Promise<object>): Promise<Response> {
  try {
    return answer(200, await step());
  } catch (error) {
    if (error instanceof MoneyError) {
      return answer(MONEY_STATUS[error.reason], {
        reason: error.reason,
        ...(error.reason === "paypal_refused" ? { issues: [...error.issues] } : {}),
      });
    }
    throw error;
  }
}

/**
 * A refusal.
 *
 * @param status - The HTTP status.
 * @param reason - Why.
 * @returns The response.
 */
function refuse(status: number, reason: OwnerRefusal): Response {
  return answer(status, { reason });
}

/**
 * A JSON answer, never cached: it is one owner's money.
 *
 * @param status - The HTTP status.
 * @param body - The body.
 * @returns The response.
 */
function answer(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
