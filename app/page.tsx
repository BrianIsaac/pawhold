import buttons from "./components/Button.module.css";
import styles from "./landing.module.css";

/**
 * The landing page (judge mode): section 6's heading, its line, the two
 * doors and the line under them (decision D11). The doors are plain links,
 * never prefetched, so they work without JavaScript and a page view starts
 * no session; each starts the visitor's own session on its first click
 * (`/try/{door}`, plan 7.4).
 *
 * @returns The landing page.
 */
export default function HomePage() {
  return (
    <main className={styles.landing}>
      <div className={styles.inner}>
        <p className={styles.brand}>pawhold</p>
        <h1 className={styles.heading}>Estimates your clients can say yes to.</h1>
        <p className={styles.lede}>
          pawhold turns a vet&apos;s notes into an itemised estimate, holds it on the owner&apos;s
          PayPal or card, asks before anything extra, and charges exactly the bill. Sandbox only: no
          real money moves.
        </p>
        <nav className={styles.doors} aria-label="Try pawhold">
          {/* The doors are route handlers, not pages: a full navigation sets the session's cookie. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/try/practice" className={buttons.button} data-variant="primary">
            Try it as the practice
          </a>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/try/owner" className={buttons.button} data-variant="primary">
            Try it as the owner
          </a>
        </nav>
        <p className={styles.note}>
          You&apos;ll get your own practice with cases at every stage. The PayPal sandbox login is
          on the owner&apos;s page.
        </p>
      </div>
    </main>
  );
}
