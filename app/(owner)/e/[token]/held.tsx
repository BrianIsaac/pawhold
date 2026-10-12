"use client";

import { useEffect, useState } from "react";

import { confirmedByPayPal, HELD, heldDone, WAITING_FOR_PAYPAL } from "@/owner/wording";

import styles from "./authorise.module.css";

/** The hold as the server answers it. */
export interface HoldState {
  readonly status:
    "ordered" | "authorised" | "captured" | "voided" | "expired" | "withdrawn" | "declined";
  readonly paymentKind: "paypal" | "card" | null;
  readonly amountPence: number;
  readonly confirmedAt: string | null;
}

/** How often, and for how long, the page asks for PayPal's confirmation. */
const POLL_EVERY_MS = 3_000;
const POLL_FOR_MS = 60_000;

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
 * The hold once PayPal answered the authorisation: "Held", section 6's
 * "Done." sentence, then "Confirmed by PayPal {time}" when the webhook's tick
 * lands, asked for every few seconds for up to a minute.
 *
 * @param props - The link, what is held and the hold.
 * @param props.token - The link's token.
 * @param props.amount - What is held, shown.
 * @param props.hold - The hold as last answered.
 * @returns The hold's status.
 */
export function HeldStatus({
  token,
  amount,
  hold: initial,
}: {
  readonly token: string;
  readonly amount: string;
  readonly hold: HoldState & { readonly paymentKind: "paypal" | "card" };
}) {
  const [confirmedAt, setConfirmedAt] = useState(initial.confirmedAt);
  const [stoppedWaiting, setStoppedWaiting] = useState(false);

  useEffect(() => {
    if (confirmedAt) {
      return;
    }
    let ended = false;
    const until = Date.now() + POLL_FOR_MS;
    const poll = async () => {
      while (!ended && Date.now() < until) {
        await pause(POLL_EVERY_MS);
        const response = await fetch(`/e/${token}/status`, { cache: "no-store" }).catch(() => null);
        const answer = response?.ok
          ? ((await response.json()) as { hold: HoldState | null })
          : null;
        if (!ended && answer?.hold?.confirmedAt) {
          setConfirmedAt(answer.hold.confirmedAt);
          return;
        }
      }
      if (!ended) {
        setStoppedWaiting(true);
      }
    };
    void poll();
    return () => {
      ended = true;
    };
  }, [confirmedAt, token]);

  return (
    <div className={styles.held} role="status" aria-live="polite">
      <p className={styles.heldChip}>{HELD}</p>
      <p className={styles.heldDone}>{heldDone(amount, initial.paymentKind)}</p>
      {confirmedAt ? (
        <p className={styles.confirmed}>{confirmedByPayPal(new Date(confirmedAt))}</p>
      ) : !stoppedWaiting ? (
        <p className={styles.waiting}>{WAITING_FOR_PAYPAL}</p>
      ) : null}
    </div>
  );
}
