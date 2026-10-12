import type { ReactNode } from "react";

import { linesAdded } from "@/estimate/added";
import { formatMoney } from "@/money/format";
import type { CaseView } from "@/practice/estimate";
import { reviewedOf, type VersionPanel } from "@/practice/panels";
import { practiceDay } from "@/practice/time";
import { askToApprove, updateDeclined } from "@/practice/wording";

import {
  addLineAction,
  draftUpdateAction,
  editLineAction,
  removeLineAction,
  sendAction,
  withdrawAction,
} from "./actions";
import { ActionDialog } from "./ActionDialog";
import { AddItemForm } from "./AddItemForm";
import styles from "./case.module.css";
import { DraftOutcome } from "./DraftOutcome";
import { itemOptions } from "./EstimateSection";
import { NotesWithSpans } from "./NotesWithSpans";
import { OwnerLinkHint } from "./OwnerLinkHint";
import { UpdateForm } from "./UpdateForm";
import { VersionLines } from "./VersionLines";

/**
 * The vet's finding with each added line's span marked, the photo, and what
 * the owner will read.
 *
 * @param props - The case and the update's panel.
 * @param props.view - The case.
 * @param props.panel - The update.
 * @param props.children - What follows (the form to draft again).
 * @returns The finding panel.
 */
function FindingPanel({
  view,
  panel,
  children,
}: {
  view: CaseView;
  panel: VersionPanel;
  children?: ReactNode;
}) {
  const source = panel.source;
  const first = view.case.ownerFirstName;
  const titleId = `finding-${panel.version.number}-title`;
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.panelTitle}>
        The finding
      </h3>
      {source ? (
        <NotesWithSpans text={source.text} spans={panel.spans} />
      ) : (
        <p className={styles.muted}>This update was made by hand, with no finding drafted from.</p>
      )}
      {source?.photo ? (
        <figure className={styles.photo}>
          {/* The practice's own photo, served by the case's photo route; not a next/image source. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/cases/${view.case.id}/photo/${panel.version.id}`}
            alt={`The photo added to the update for ${view.case.patientName}`}
          />
          <figcaption className={styles.muted}>
            {source.photo.shared
              ? `${first} sees this photo.`
              : "Only the practice sees this photo."}
          </figcaption>
        </figure>
      ) : null}
      {source ? (
        <div className={styles.explanation}>
          <h4 className={styles.subTitle}>What {first} will read</h4>
          {source.explanation ? (
            <p>{source.explanation}</p>
          ) : (
            <p className={styles.muted}>
              The draft&apos;s explanation was held back, so {first} reads your own words.
            </p>
          )}
          <p className={styles.muted}>Beside it, {first} can always read what you wrote.</p>
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The case's update (section 6, "an update"): the finding and its photo, the
 * drafted delta, the Order's trigger sentence, and "Ask {owner} to approve
 * {delta}"; the update with the owner; the one they declined; those they approved.
 *
 * @param props - The case.
 * @param props.view - The case.
 * @param props.ownerPath - The owner's link while their answer is awaited, or null.
 * @returns The section's body, or nothing before the estimate is held.
 */
export function UpdateSection({ view, ownerPath }: { view: CaseView; ownerPath: string | null }) {
  const { update } = view;
  const caseId = view.case.id;
  const first = view.case.ownerFirstName;
  const draftAction = draftUpdateAction.bind(null, caseId);
  const money = (pence: number) => formatMoney({ pence, currency: view.currency });
  const draftAdded = update.draft
    ? linesAdded(update.draft.basedOn.lines, update.draft.panel.version.lines)
    : [];

  return (
    <div className={styles.stack}>
      {update.approved.map((panel) => (
        <div key={panel.version.id} className={styles.columns}>
          {panel.source ? <FindingPanel view={view} panel={panel} /> : null}
          <section
            className={panel.source ? styles.panel : `${styles.panel} ${styles.secondColumn}`}
            aria-label={`Update ${first} approved, version ${panel.version.number}`}
          >
            <h3 className={styles.panelTitle}>
              Update {first} approved, version {panel.version.number}
            </h3>
            <VersionLines panel={panel} currency={view.currency} only={addedOver(view, panel)} />
          </section>
        </div>
      ))}

      {update.declined ? (
        <div className={styles.columns}>
          <FindingPanel view={view} panel={update.declined.panel} />
          <section className={styles.panel} aria-labelledby="declined-title">
            <h3 id="declined-title" className={styles.panelTitle}>
              Update declined, version {update.declined.panel.version.number}
            </h3>
            <p className={styles.notice}>
              {updateDeclined(
                first,
                practiceDay(update.declined.declinedAt),
                view.money.heldPence,
                view.currency,
              )}
            </p>
            <VersionLines
              panel={update.declined.panel}
              currency={view.currency}
              only={addedOver(view, update.declined.panel)}
            />
          </section>
        </div>
      ) : null}

      {update.awaiting ? (
        <div className={styles.columns}>
          <FindingPanel view={view} panel={update.awaiting.panel} />
          <section className={styles.panel} aria-labelledby="awaiting-title">
            <h3 id="awaiting-title" className={styles.panelTitle}>
              Update sent to {first}, version {update.awaiting.panel.version.number}
            </h3>
            <VersionLines
              panel={update.awaiting.panel}
              currency={view.currency}
              only={addedOver(view, update.awaiting.panel)}
            />
            <p className={styles.muted}>
              Waiting for {first} to approve {money(update.awaiting.increasePence)}.
            </p>
            {ownerPath ? <OwnerLinkHint path={ownerPath} ownerFirstName={first} /> : null}
            <div className={styles.actions}>
              <ActionDialog
                id="withdraw-update"
                trigger="Withdraw the update"
                triggerVariant="danger"
                title="Withdraw the update?"
                actionLabel="Withdraw it"
                actionVariant="danger"
                action={withdrawAction.bind(null, { caseId, what: "update" })}
              >
                <p className={styles.muted}>
                  {first} won&apos;t be able to approve it. What {first} approved before stays held.
                </p>
              </ActionDialog>
            </div>
          </section>
        </div>
      ) : null}

      {update.draft ? (
        <div className={styles.columns}>
          <FindingPanel view={view} panel={update.draft.panel}>
            {update.canDraft ? (
              <details>
                <summary className={styles.editorSummary}>
                  Change the finding and draft again
                </summary>
                <UpdateForm
                  action={draftAction}
                  defaultFinding={update.draft.panel.source?.text ?? ""}
                  redraft
                />
              </details>
            ) : null}
          </FindingPanel>
          <section className={styles.panel} aria-labelledby="update-draft-title">
            <h3 id="update-draft-title" className={styles.panelTitle}>
              Update, version {update.draft.panel.version.number}
            </h3>
            <DraftOutcome source={update.draft.panel.source} />
            {draftAdded.length === 0 ? (
              <p className={styles.muted}>Nothing added yet.</p>
            ) : (
              <VersionLines
                panel={update.draft.panel}
                currency={view.currency}
                only={new Set(draftAdded.map((line) => line.id))}
                actions={(lineId) => ({
                  save: editLineAction.bind(null, {
                    caseId,
                    versionId: update.draft!.panel.version.id,
                    lineId,
                  }),
                  remove: removeLineAction.bind(null, {
                    caseId,
                    versionId: update.draft!.panel.version.id,
                    lineId,
                  }),
                })}
              />
            )}
            <AddItemForm action={addLineAction.bind(null, caseId)} groups={itemOptions(view)} />
            <p className={styles.trigger}>{update.draft.triggerSentence}</p>
            <div className={styles.actions}>
              <ActionDialog
                id="send-update"
                trigger={askToApprove(first, update.draft.increasePence, view.currency)}
                title={`Ask ${first} to approve the update?`}
                actionLabel={askToApprove(first, update.draft.increasePence, view.currency)}
                action={sendAction.bind(null, {
                  caseId,
                  versionId: update.draft.panel.version.id,
                  sent: "update",
                  reviewed: reviewedOf(update.draft.panel.version),
                })}
                disabled={update.draft.increasePence <= 0}
              >
                <ul className={styles.review} aria-label={`What the update adds for ${first}`}>
                  {draftAdded.map((line) => (
                    <li key={line.id} className={styles.reviewLine}>
                      <span>{line.ownerWording ?? line.name}</span>
                      <span>{money(line.highPence)}</span>
                    </li>
                  ))}
                </ul>
                <p className={styles.total}>
                  {first} is asked to approve {money(update.draft.increasePence)} more.
                </p>
                <p className={styles.muted}>
                  Sending records your approval of the update as{" "}
                  {view.case.vetName ?? "the case's vet"}.
                </p>
              </ActionDialog>
            </div>
          </section>
        </div>
      ) : update.canDraft && !update.awaiting ? (
        <section className={styles.panel} aria-labelledby="new-update-title">
          <h3 id="new-update-title" className={styles.panelTitle}>
            Add an update
          </h3>
          <UpdateForm action={draftAction} defaultFinding="" redraft={false} />
        </section>
      ) : null}
    </div>
  );
}

/**
 * The lines an update added or changed over the version the owner approved
 * before it (U11: by line, not by count, so a line an update raised shows).
 *
 * @param view - The case.
 * @param panel - The update.
 * @returns The ids of its added or changed lines.
 */
function addedOver(view: CaseView, panel: VersionPanel): ReadonlySet<string> {
  const base = view.approved.filter((one) => one.version.number < panel.version.number).at(-1);
  return new Set(linesAdded(base?.version.lines ?? [], panel.version.lines).map((line) => line.id));
}
