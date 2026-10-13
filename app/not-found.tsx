import { ButtonLink } from "./components/Button";
import { StatePanel } from "./components/StatePanel";
import styles from "./landing.module.css";

/**
 * Any address pawhold has no page for (U11; this unit's words, D11).
 *
 * @returns The page.
 */
export default function NotFound() {
  return (
    <main className={styles.landing}>
      <div className={styles.inner}>
        <StatePanel
          heading="There's nothing here"
          text="This page doesn't exist, or it belongs to another visitor's practice."
        >
          <ButtonLink href="/">Go to pawhold&apos;s start page</ButtonLink>
        </StatePanel>
      </div>
    </main>
  );
}
