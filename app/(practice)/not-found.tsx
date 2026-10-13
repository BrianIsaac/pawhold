import { ButtonLink } from "../components/Button";
import { StatePanel } from "../components/StatePanel";

/**
 * A case, bill or day the practice does not have (U11; this unit's words,
 * D11): another visitor's case is not found, never shown.
 *
 * @returns The page.
 */
export default function PracticeNotFound() {
  return (
    <StatePanel
      heading="There's nothing here"
      text="This page doesn't exist, or it belongs to another visitor's practice."
    >
      <ButtonLink href="/today">Today&apos;s cases</ButtonLink>
    </StatePanel>
  );
}
