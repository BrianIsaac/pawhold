"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DECLINE_FAILED, DONT_GO_AHEAD, PRACTICE_WILL_CALL } from "@/owner/wording";

import styles from "./authorise.module.css";

/**
 * The owner's "Don't go ahead" on an update (section 6): asks the server to
 * decline it (U3's `declineUpdate`, for the version this link shows), then
 * shows the page as it now stands.
 *
 * @param props - The link.
 * @param props.token - The link's token.
 * @returns The button and what follows it.
 */
export function Decline({ token }: { readonly token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const decline = async () => {
    setBusy(true);
    setFailed(false);
    const response = await fetch(`/e/${token}/decline`, { method: "POST" }).catch(() => null);
    if (response?.ok || response?.status === 409) {
      router.refresh();
      return;
    }
    setFailed(true);
    setBusy(false);
  };

  return (
    <div className={styles.decline}>
      {failed ? (
        <p className={styles.error} role="alert">
          {DECLINE_FAILED}
        </p>
      ) : null}
      <button
        type="button"
        className={styles.declineButton}
        onClick={() => void decline()}
        disabled={busy}
        aria-describedby="decline-note"
      >
        {DONT_GO_AHEAD}
      </button>
      <p id="decline-note" className={styles.note}>
        {PRACTICE_WILL_CALL}
      </p>
    </div>
  );
}
