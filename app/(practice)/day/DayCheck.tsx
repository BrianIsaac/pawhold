"use client";

import { useEffect, useState } from "react";

import { checkTheDayAction } from "./actions";
import styles from "./day.module.css";

/** How often the open day asks the agent to check it. */
const CHECK_EVERY_MS = 60_000;

/**
 * Asks the schedule agent to check the practice's day when the page opens,
 * each minute while it stays open and in view, and when it comes back into
 * view, so a slot inside the lead time is held while the practice watches.
 * Each check shows the day afresh. Says when it last checked, and announces
 * only a check that changed something.
 *
 * @param props - The practice's clock.
 * @param props.timeZone - The zone its times are read in.
 * @returns The line saying when the day was checked.
 */
export function DayCheck({ timeZone }: { timeZone: string }) {
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [changedAt, setChangedAt] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const check = async () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      const answer = await checkTheDayAction();
      if (live && answer.checkedAt) {
        setCheckedAt(answer.checkedAt);
        if (answer.changed) {
          setChangedAt(answer.checkedAt);
        }
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void check();
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const minute = (iso: string): string =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  return (
    <>
      <p className={styles.check}>
        {checkedAt
          ? `pawhold checked the day at ${minute(checkedAt)}, and checks it each minute while this page is open.`
          : "pawhold is checking the day."}
      </p>
      <p role="status" className="visually-hidden">
        {changedAt ? `pawhold changed the day at ${minute(changedAt)}.` : ""}
      </p>
    </>
  );
}
