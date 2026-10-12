"use client";

import {
  type CardFieldsOneTimePaymentSession,
  loadCoreSdkScript,
  type OneTimePaymentSession,
} from "@paypal/paypal-js/sdk-v6";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  CARD_FIELD_LABELS,
  CARD_FIELD_PLACEHOLDERS,
  OR_USE_A_CARD,
  PAYPAL_ERROR,
  paypalCeilingNote,
} from "@/owner/wording";

import styles from "./authorise.module.css";
import { HeldStatus, type HoldState } from "./held";

export type { HoldState };

/** What the authorise area needs from the page. */
export interface AuthoriseProps {
  /** The sandbox app's client id: the one PayPal value the browser is given. */
  readonly clientId: string;
  /** The link's token; the owner's endpoints live under `/e/{token}/`. */
  readonly token: string;
  readonly currency: "GBP" | "USD";
  /** What authorising holds, shown ("£927.00"). */
  readonly amount: string;
  /** The card button's label ("Authorise £927.00", or "Approve £155.00" on an update). */
  readonly cardLabel: string;
}

/** How many times an authorisation PayPal did not answer is asked again (U3: ask again). */
const AUTHORISE_ATTEMPTS = 3;

/**
 * How many times the card fields' submit is made for one order: a submit
 * answered `failed` once in sixteen in the sandbox (U0), and a request the
 * network dropped is answered the same way.
 */
const CARD_SUBMIT_ATTEMPTS = 3;

type Phase = "loading" | "ready" | "working" | "held" | "unavailable";

const CARD_FIELDS = ["name", "number", "expiry", "cvv"] as const;

/** The card fields' edge, as `--owner-field` (PayPal's frames cannot read the page's CSS). */
const FIELD_EDGE = "#847d72";

/** The card fields' placeholder text: 5.8:1 on white, where PayPal's default is faint. */
const PLACEHOLDER = "#6b655d";

/** A refusal from the owner's endpoints. */
class OwnerRequestError extends Error {
  override readonly name = "OwnerRequestError";

  /**
   * @param status - The HTTP status.
   * @param reason - The endpoint's reason.
   */
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`the owner's request was refused: ${status} ${reason}`);
  }
}

/**
 * Posts to one of the owner's endpoints.
 *
 * @param token - The link's token.
 * @param path - The endpoint.
 * @param body - The JSON body, if any.
 * @returns The answer's JSON.
 * @throws OwnerRequestError when the endpoint refuses.
 */
async function post<T>(token: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/e/${token}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer = (await response.json().catch(() => ({}))) as T & { reason?: string };
  if (!response.ok) {
    throw new OwnerRequestError(response.status, answer.reason ?? "unknown");
  }
  return answer;
}

/**
 * Waits.
 *
 * @param ms - How long.
 * @returns When done.
 */
function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Submits the card fields for the order, again after a pause when the
 * submit failed or threw; a buyer's own cancel is never retried.
 *
 * @param card - The card fields' session.
 * @param orderId - The hold's order.
 * @returns The last submit's state.
 */
async function submitCard(
  card: CardFieldsOneTimePaymentSession,
  orderId: string,
): Promise<"succeeded" | "canceled" | "failed"> {
  for (let attempt = 1; ; attempt += 1) {
    const state = await card
      .submit(orderId, { billingAddress: { countryCode: "GB" } })
      .then((result) => result.state)
      .catch(() => "failed" as const);
    if (state !== "failed" || attempt === CARD_SUBMIT_ATTEMPTS) {
      return state;
    }
    await pause(1_500 * attempt);
  }
}

/**
 * PayPal's button and card fields through JS SDK v6, then the hold
 * (`HeldStatus`). The order
 * is made by the server (`createOrder`), PayPal's approval happens in
 * PayPal's own window, and the server authorises it (`onApprove`, or the
 * card fields' submit), so no PayPal secret or order body reaches the page.
 *
 * @param props - The link, the amounts and the hold.
 * @returns The authorise area.
 */
export function Authorise(props: AuthoriseProps) {
  const { clientId, token, currency } = props;
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [hold, setHold] = useState<HoldState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paypalSlot = useRef<HTMLDivElement>(null);
  const cardSlots = useRef<Partial<Record<(typeof CARD_FIELDS)[number], HTMLDivElement | null>>>(
    {},
  );
  const cardSession = useRef<CardFieldsOneTimePaymentSession | null>(null);

  const createOrder = useCallback(
    async (): Promise<{ orderId: string }> => post<{ orderId: string }>(token, "order"),
    [token],
  );

  /**
   * Asks the server to authorise the approved order, again when PayPal
   * gave no answer; a refusal shows section 6's error, a state the page no
   * longer matches reloads it.
   */
  const authorise = useCallback(
    async (orderId: string): Promise<void> => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const held = await post<HoldState>(token, "authorise", { orderId });
          if (held.status === "authorised") {
            setHold(held);
            setPhase("held");
          }
          // The page as it now stands: an update's "Don't go ahead" goes once it is held.
          router.refresh();
          return;
        } catch (failure) {
          const unavailable =
            failure instanceof OwnerRequestError && failure.reason === "paypal_unavailable";
          if (unavailable && attempt < AUTHORISE_ATTEMPTS) {
            await pause(1_500 * attempt);
            continue;
          }
          if (failure instanceof OwnerRequestError && failure.status === 409) {
            router.refresh();
            return;
          }
          setError(PAYPAL_ERROR);
          setPhase("ready");
          return;
        }
      }
    },
    [router, token],
  );

  useEffect(() => {
    if (phase !== "loading") {
      return;
    }
    let ended = false;
    let paypalSession: OneTimePaymentSession | null = null;
    const mounted: HTMLElement[] = [];
    const slots = cardSlots.current;

    const start = async () => {
      const namespace = await loadCoreSdkScript({ environment: "sandbox" });
      if (!namespace) {
        throw new Error("PayPal's SDK did not load");
      }
      const sdk = await namespace.createInstance({
        clientId,
        components: ["paypal-payments", "card-fields"],
        pageType: "checkout",
        locale: "en-GB",
      });
      // Eligibility does not gate either way to pay: the sandbox's answer
      // failed in two of ten calls (U0's P6), and PayPal's card-fields guide
      // says to integrate defensively.
      await sdk.findEligibleMethods({ currencyCode: currency }).catch(() => null);
      if (ended) {
        return;
      }

      paypalSession = sdk.createPayPalOneTimePaymentSession({
        // Not a purchase: PayPal's window offers "Continue", and the page
        // authorises the hold once the owner comes back.
        commit: false,
        onApprove: async ({ orderId }) => {
          setPhase("working");
          await authorise(orderId);
        },
        onCancel: () => setPhase("ready"),
        onError: () => {
          setError(PAYPAL_ERROR);
          setPhase("ready");
        },
      });
      const session = paypalSession;
      const button = document.createElement("paypal-button");
      // No `type`: PayPal's plain mark. "Pay", "Buy Now" and "Check Out" all say
      // money moves now, and authorising moves none until discharge.
      button.addEventListener("click", () => {
        setError(null);
        // The order's promise is made in the click, not awaited first, so the
        // popup keeps the click's transient activation (PayPal's v6 sample).
        void session.start({ presentationMode: "auto" }, createOrder()).catch(() => {
          setError(PAYPAL_ERROR);
          setPhase("ready");
        });
      });
      paypalSlot.current?.append(button);
      mounted.push(button);

      const card = sdk.createCardFieldsOneTimePaymentSession();
      for (const type of CARD_FIELDS) {
        const field = card.createCardFieldsComponent({
          type,
          ariaLabel: CARD_FIELD_LABELS[type],
          placeholder: CARD_FIELD_PLACEHOLDERS[type],
          style: {
            input: {
              fontSize: "16px",
              fontFamily: "system-ui, sans-serif",
              color: "#1d2327",
              border: `1px solid ${FIELD_EDGE}`,
              borderRadius: "4px",
            },
            "input::placeholder": { color: PLACEHOLDER },
          },
        });
        slots[type]?.append(field);
        mounted.push(field);
      }
      cardSession.current = card;
      setPhase("ready");
    };

    start().catch(() => {
      if (!ended) {
        setError(PAYPAL_ERROR);
        setPhase("unavailable");
      }
    });

    return () => {
      ended = true;
      paypalSession?.destroy();
      for (const element of mounted) {
        element.remove();
      }
      cardSession.current = null;
    };
    // The SDK mounts once per page; the callbacks it holds read refs and setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const payByCard = async () => {
    const card = cardSession.current;
    if (!card || phase !== "ready") {
      return;
    }
    setError(null);
    setPhase("working");
    try {
      const { orderId } = await createOrder();
      const result = await submitCard(card, orderId);
      if (result === "succeeded") {
        await authorise(orderId);
        return;
      }
      if (result === "failed") {
        setError(PAYPAL_ERROR);
      }
      setPhase("ready");
    } catch {
      setError(PAYPAL_ERROR);
      setPhase("ready");
    }
  };

  if (phase === "held" && hold?.status === "authorised" && hold.paymentKind) {
    return (
      <HeldStatus
        token={token}
        amount={props.amount}
        hold={{ ...hold, paymentKind: hold.paymentKind }}
      />
    );
  }

  const busy = phase !== "ready";
  return (
    <div className={styles.authorise} aria-busy={phase === "loading" || phase === "working"}>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div ref={paypalSlot} className={styles.paypalButton} data-testid="paypal-button-slot" />
      <p className={styles.divider}>
        <span>{OR_USE_A_CARD}</span>
      </p>
      <div className={styles.cardFields}>
        {CARD_FIELDS.map((type) => (
          <div key={type} className={styles.cardField}>
            <span className={styles.cardLabel} aria-hidden="true">
              {CARD_FIELD_LABELS[type]}
            </span>
            <div
              ref={(slot) => {
                cardSlots.current[type] = slot;
              }}
              className={styles.cardSlot}
              data-card-field={type}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        className={styles.cardButton}
        onClick={() => void payByCard()}
        disabled={busy}
      >
        {props.cardLabel}
      </button>
      <p className={styles.note}>{paypalCeilingNote(props.amount)}</p>
    </div>
  );
}
