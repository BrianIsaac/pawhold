import styles from "./Wordmark.module.css";

/**
 * pawhold's wordmark: the paw tile (app/icon.svg's drawing, a mint paw on
 * saddle) and the name in saddle. The tile is decoration; the name is the
 * words a screen reader reads.
 *
 * @returns The wordmark.
 */
export function Wordmark() {
  return (
    <span className={styles.wordmark}>
      <svg className={styles.tile} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <rect className={styles.ground} width="64" height="64" rx="16" />
        <g className={styles.paw}>
          <ellipse cx="32" cy="42" rx="12" ry="10" />
          <circle cx="17" cy="28" r="5.5" />
          <circle cx="26" cy="18" r="5.5" />
          <circle cx="38" cy="18" r="5.5" />
          <circle cx="47" cy="28" r="5.5" />
        </g>
      </svg>
      pawhold
    </span>
  );
}
