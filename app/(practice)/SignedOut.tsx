"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "../components/Button";
import styles from "./practice.module.css";

/**
 * What a visitor with no session sees on a practice screen: section 6's door
 * "Try it as the practice", which starts U1's judge session (a practice of
 * their own, seeded) and shows the page signed in.
 *
 * @returns The panel.
 */
export function SignedOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const start = async () => {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch("/api/judge/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ door: "practice" }),
      });
      if (!response.ok) {
        throw new Error(`the session was not started: ${response.status}`);
      }
      router.refresh();
    } catch {
      setFailed(true);
      setPending(false);
    }
  };

  return (
    <section className={`${styles.panel} ${styles.signedOut}`} aria-labelledby="signed-out-title">
      <h1 id="signed-out-title" className={styles.title}>
        The practice&apos;s screens
      </h1>
      <p>
        You&apos;ll get your own practice with cases at every stage. Nothing you do here is seen by
        anyone else.
      </p>
      {failed ? (
        <p role="alert" className={styles.alert}>
          That didn&apos;t work. Try again.
        </p>
      ) : null}
      <div>
        <Button onClick={start} pending={pending}>
          Try it as the practice
        </Button>
      </div>
    </section>
  );
}
