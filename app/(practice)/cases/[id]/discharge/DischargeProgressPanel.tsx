"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

import type { DischargeProgressJson, ProgressStepJson } from "@/discharge/progress";
import { money } from "@/discharge/wording";
import { practiceSecond } from "@/practice/time";

import { Button } from "../../../../components/Button";
import caseStyles from "../case.module.css";
import type { DischargeAnswer } from "./actions";
import styles from "./discharge.module.css";

/** How often the page asks for the discharge's progress, as the owner's page polls (U6). */
const POLL_MS = 3_000;

/** How long the page keeps asking before it leaves the rest to a reload. */
const POLL_FOR_MS = 5 * 60 * 1000;

/**
 * The discharge as it lands: each hold's capture and release with
 * "Confirmed by PayPal {time}" from the webhook's tick, polled from the case's
 * status route until every step has landed and is confirmed; a discharge that
 * stopped part way offers "Resume".
 *
 * @param props - The case, the owner's first name, the progress as first rendered, and the bound resume.
 * @param props.caseId - The case.
 * @param props.ownerFirstName - The owner's first name.
 * @param props.initial - The progress when the page was rendered.
 * @param props.resume - The resume action, bound to the case.
 * @returns The panel.
 */
export function DischargeProgressPanel({
  caseId,
  ownerFirstName,
  initial,
  resume,
}: {
  caseId: string;
  ownerFirstName: string;
  initial: DischargeProgressJson;
  resume: () => Promise<DischargeAnswer>;
}) {
  const [progress, setProgress] = useState(initial);
  const [gaveUp, setGaveUp] = useState(false);
  const [state, submitResume, resuming] = useActionState(resume, { message: null });
  const settled = progress.finished && progress.confirmed;
  const router = useRouter();
  const finished = useRef(initial.finished);

  // The page's head (the case's chips) was drawn before the steps landed:
  // draw it again once the last hold closes.
  useEffect(() => {
    if (progress.finished && !finished.current) {
      finished.current = true;
      router.refresh();
    }
  }, [progress.finished, router]);

  useEffect(() => {
    if (settled) {
      return;
    }
    const started = Date.now();
    let stopped = false;
    const timer = setInterval(() => {
      if (Date.now() - started > POLL_FOR_MS) {
        clearInterval(timer);
        setGaveUp(true);
        return;
      }
      void fetch(`/cases/${caseId}/discharge/status`, { cache: "no-store" })
        .then(async (response) =>
          response.ok ? ((await response.json()) as DischargeProgressJson) : null,
        )
        .then(
          (next) => {
            if (next && !stopped) {
              setProgress(next);
            }
          },
          () => {
            // A poll lost on the way is asked again at the next tick.
          },
        );
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [caseId, settled]);

  const { currency } = progress;
  return (
    <section className={caseStyles.panel} aria-labelledby="discharge-title">
      <h2 id="discharge-title" className={caseStyles.panelTitle}>
        {progress.finished ? "Discharged" : "Charging"}
      </h2>
      <p role="status" className={styles.summary}>
        {progress.finished
          ? `${money(progress.capturedPence, currency)} captured. ${
              progress.releasedPence > 0
                ? `${money(progress.releasedPence, currency)} released to ${ownerFirstName}.`
                : "Nothing was left to release."
            }`
          : `Charging ${money(progress.billedPence, currency)}: each hold's capture and release show here as they land.`}
      </p>
      <ol className={styles.holds}>
        {progress.holds.map((one) => (
          <li key={one.holdId} className={styles.hold}>
            <h3 className={caseStyles.subTitle}>
              {one.name}, {money(one.amountPence, currency)}
            </h3>
            <ul className={styles.steps}>
              {one.capture ? (
                <Step label={`Captured ${money(one.capture.pence, currency)}`} step={one.capture} />
              ) : one.plannedCapturePence > 0 && !one.expired ? (
                <li className={styles.step}>
                  <span>Waiting to capture {money(one.plannedCapturePence, currency)}</span>
                </li>
              ) : null}
              {one.release ? (
                <Step
                  label={`Released ${money(one.release.pence, currency)} to ${ownerFirstName}`}
                  step={one.release}
                />
              ) : one.plannedReleasePence > 0 && !one.expired ? (
                <li className={styles.step}>
                  <span>Waiting to release {money(one.plannedReleasePence, currency)}</span>
                </li>
              ) : null}
              {one.expired ? (
                <li className={styles.step}>
                  <span className={styles.refused}>
                    PayPal found this hold expired. Its share of the bill is unpaid: collect it
                    another way.
                  </span>
                </li>
              ) : null}
              {one.refused ? (
                <li className={styles.step}>
                  <span className={styles.refused}>
                    PayPal refused a step for this hold. The case&apos;s timeline has PayPal&apos;s
                    reason.
                  </span>
                </li>
              ) : null}
            </ul>
          </li>
        ))}
      </ol>
      {progress.unpaidPence > 0 ? (
        <p className={caseStyles.notice}>
          {money(progress.unpaidPence, currency)} of the bill could not be captured.
        </p>
      ) : null}
      {progress.stalled ? (
        <form action={submitResume} className={styles.resume}>
          <p className={caseStyles.notice}>
            The discharge stopped before it finished. Nothing is captured or released twice: resume
            it to finish.
          </p>
          {state.message ? (
            <p role="alert" className={caseStyles.notice}>
              {state.message}
            </p>
          ) : null}
          <div>
            <Button type="submit" pending={resuming}>
              Resume
            </Button>
          </div>
        </form>
      ) : null}
      {gaveUp && !settled ? (
        <p className={caseStyles.muted}>
          Still waiting for PayPal. Reload the page to check again.
        </p>
      ) : null}
    </section>
  );
}

/**
 * A landed step: what moved, when, and PayPal's confirmation.
 *
 * @param props - The step's words and the step.
 * @param props.label - What moved.
 * @param props.step - The step.
 * @returns The row.
 */
function Step({ label, step }: { label: string; step: ProgressStepJson }) {
  return (
    <li className={styles.step}>
      <span>
        {label} at {practiceSecond(new Date(step.at))}
      </span>
      {step.confirmedAt ? (
        <span className={styles.confirmed}>
          Confirmed by PayPal {practiceSecond(new Date(step.confirmedAt))}
        </span>
      ) : (
        <span className={styles.waiting}>Waiting for PayPal to confirm</span>
      )}
    </li>
  );
}
