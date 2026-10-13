"use client";

import { Button, ButtonLink } from "../components/Button";
import { StatePanel } from "../components/StatePanel";

/**
 * A practice screen that failed to render (U11; this unit's words, D11):
 * says nothing was charged by it, and offers to try again or go back to
 * today's cases. Inside the practice's layout, so the navigation stays.
 *
 * @param props - What failed and how to try again.
 * @param props.error - The error (its digest is in the server's log).
 * @param props.reset - Renders the screen again.
 * @returns The page.
 */
export default function PracticeError({
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <StatePanel
      heading="Something went wrong"
      text="pawhold couldn't show this page. Nothing has been charged by it. Try again, or go back to today's cases."
    >
      <Button onClick={reset}>Try again</Button>
      <ButtonLink href="/today" variant="secondary">
        Today&apos;s cases
      </ButtonLink>
    </StatePanel>
  );
}
