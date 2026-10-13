"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { z } from "zod";

/** How often the open day asks whether anything on it has changed. */
const ASK_EVERY_MS = 3_000;

const answer = z.object({ stamp: z.string() });

/**
 * Keeps the open day live (U8b): asks every few seconds, while the page is
 * in view, for the practice's day stamp, and has the day read again when the
 * stamp is not the one the page was drawn from, so a case turning held, or
 * a slot the agent held, shows without a reload. A request that fails is
 * left for the next one.
 *
 * @param props - The stamp the page was drawn from.
 * @param props.stamp - The practice's day stamp when the server drew the page.
 * @returns Nothing drawn.
 */
export function DayLive({ stamp }: { stamp: string }) {
  const router = useRouter();
  const drawn = useRef(stamp);
  const asked = useRef<string | null>(null);

  useEffect(() => {
    drawn.current = stamp;
  }, [stamp]);

  useEffect(() => {
    let live = true;
    const ask = async () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      try {
        const response = await fetch("/day/changes", { cache: "no-store" });
        const parsed = response.ok ? answer.safeParse(await response.json()) : null;
        const latest = parsed?.success ? parsed.data.stamp : null;
        // Each stamp is acted on once, so a day already being read again is not asked for twice.
        if (live && latest !== null && latest !== drawn.current && latest !== asked.current) {
          asked.current = latest;
          router.refresh();
        }
      } catch {
        // The network dropped this one; the next asks again.
      }
    };
    const timer = window.setInterval(() => void ask(), ASK_EVERY_MS);
    const onVisible = () => void ask();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return null;
}
