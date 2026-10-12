import styles from "./case.module.css";

/**
 * The page the owner's link opens, offered to the practice while the owner's
 * answer is awaited (U11; U9's finding 7). Every practice is a demo practice
 * (judge mode, plan 7.4), and a judge who sends an estimate has no phone to
 * receive its link: this opens it as the owner would. Its words are this
 * unit's, flagged (D11).
 *
 * @param props - The link and whose it is.
 * @param props.path - The owner's link's path, `/e/{token}`.
 * @param props.ownerFirstName - The owner's first name.
 * @returns The hint.
 */
export function OwnerLinkHint({
  path,
  ownerFirstName,
}: {
  readonly path: string;
  readonly ownerFirstName: string;
}) {
  return (
    <div className={styles.ownerLink}>
      <p className={styles.muted}>
        There is no phone in the demo: this is the page {ownerFirstName}&apos;s link opens.
      </p>
      <a href={path} target="_blank" rel="noopener" className={styles.ownerLinkButton}>
        Open {ownerFirstName}&apos;s page
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </div>
  );
}
