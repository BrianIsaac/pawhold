import type { ReactNode } from "react";

import { formatMoney } from "@/money/format";
import type { CaseView, ListGroup, VersionPanel } from "@/practice/estimate";
import { reviewedOf } from "@/practice/panels";
import { estimateTotal, sendTo } from "@/practice/wording";

import {
  addLineAction,
  draftAgainAction,
  draftEstimateAction,
  editLineAction,
  removeLineAction,
  sendAction,
  withdrawAction,
} from "./actions";
import { ActionButton } from "./ActionButton";
import { ActionDialog } from "./ActionDialog";
import { AddItemForm } from "./AddItemForm";
import styles from "./case.module.css";
import { DraftOutcome } from "./DraftOutcome";
import { NotesForm } from "./NotesForm";
import { NotesWithSpans } from "./NotesWithSpans";
import { VersionLines } from "./VersionLines";

/** A category's name as a heading reads it. */
export const CATEGORY_NAMES: Record<ListGroup["category"], string> = {
  consultation: "Consultation",
  anaesthesia: "Anaesthesia",
  procedure: "Procedure",
  imaging: "Imaging",
  laboratory: "Laboratory",
  medication: "Medication",
  hospitalisation: "Hospitalisation",
  consumable: "Consumable",
};

/**
 * The price list as the add form's option groups, each item priced.
 *
 * @param view - The case.
 * @returns The groups.
 */
export function itemOptions(view: CaseView) {
  return view.priceList.map((group) => ({
    label: CATEGORY_NAMES[group.category],
    options: group.items.map((item) => ({
      value: item.code,
      label: `${item.name} (${item.code}), ${formatMoney({ pence: item.unitPricePence, currency: view.currency })} per ${item.unit}`,
    })),
  }));
}

/**
 * The notes beside the estimate: the notes with each line's span marked,
 * and, while the agent may still draft, the notes form.
 *
 * @param props - The case, the panel and whether the agent may draft.
 * @param props.view - The case.
 * @param props.panel - The version shown, if any.
 * @param props.canDraft - Whether "Draft estimate" is offered.
 * @returns The notes panel.
 */
function NotesPanel({
  view,
  panel,
  canDraft,
}: {
  view: CaseView;
  panel: VersionPanel | null;
  canDraft: boolean;
}) {
  const source = panel?.source ?? null;
  const draftAction = draftEstimateAction.bind(null, view.case.id);
  const hasLines = (panel?.version.lines.length ?? 0) > 0;
  if (!source) {
    return (
      <div className={styles.panel}>
        {canDraft ? (
          <NotesForm action={draftAction} defaultNotes="" redraft={hasLines} />
        ) : (
          <p className={styles.muted}>
            This estimate was made by hand, with no notes drafted from.
          </p>
        )}
      </div>
    );
  }
  return (
    <section className={styles.panel} aria-labelledby="notes-title">
      <h3 id="notes-title" className={styles.panelTitle}>
        Clinical notes
      </h3>
      <NotesWithSpans text={source.text} spans={panel!.spans} />
      {canDraft ? (
        <details>
          <summary className={styles.editorSummary}>Change the notes and draft again</summary>
          <NotesForm action={draftAction} defaultNotes={source.text} redraft={hasLines} />
        </details>
      ) : null}
    </section>
  );
}

/**
 * The open draft: what the draft could not price, its lines (each can be
 * changed), the hand path, the total, and review and send.
 *
 * @param props - The case and the draft.
 * @param props.view - The case.
 * @param props.draft - The draft.
 * @returns The draft panel.
 */
function DraftPanel({ view, draft }: { view: CaseView; draft: VersionPanel }) {
  const caseId = view.case.id;
  const versionId = draft.version.id;
  const first = view.case.ownerFirstName;
  return (
    <section className={styles.panel} aria-labelledby="draft-title">
      <h3 id="draft-title" className={styles.panelTitle}>
        Draft estimate, version {draft.version.number}
      </h3>
      <DraftOutcome source={draft.source} />
      {draft.version.lines.length === 0 ? (
        <p className={styles.muted}>No items yet.</p>
      ) : (
        <VersionLines
          panel={draft}
          currency={view.currency}
          actions={(lineId) => ({
            save: editLineAction.bind(null, { caseId, versionId, lineId }),
            remove: removeLineAction.bind(null, { caseId, versionId, lineId }),
          })}
        />
      )}
      <AddItemForm action={addLineAction.bind(null, caseId)} groups={itemOptions(view)} />
      <p className={styles.total}>{estimateTotal(draft.version.totals, view.currency)}</p>
      <div className={styles.actions}>
        <ActionDialog
          id="send-estimate"
          trigger={sendTo(first)}
          title={`Send this estimate to ${first}?`}
          actionLabel={sendTo(first)}
          action={sendAction.bind(null, {
            caseId,
            versionId,
            sent: "estimate",
            reviewed: reviewedOf(draft.version),
          })}
          disabled={draft.version.lines.length === 0}
        >
          <ul className={styles.review} aria-label={`What ${first} will see`}>
            {draft.version.lines.map((line) => (
              <li key={line.id} className={styles.reviewLine}>
                <span>{line.ownerWording ?? line.name}</span>
                <span>
                  {line.lowPence === line.highPence
                    ? formatMoney({ pence: line.highPence, currency: view.currency })
                    : `${formatMoney({ pence: line.lowPence, currency: view.currency })} to ${formatMoney({ pence: line.highPence, currency: view.currency })}`}
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.total}>{estimateTotal(draft.version.totals, view.currency)}</p>
          <p className={styles.muted}>
            Sending records your approval of every line as {view.case.vetName ?? "the case's vet"}.
          </p>
        </ActionDialog>
      </div>
    </section>
  );
}

/**
 * A sent version, read only: its lines and total, and what happens next.
 *
 * @param props - The case, the version and what to say under it.
 * @param props.view - The case.
 * @param props.panel - The version.
 * @param props.title - The panel's heading.
 * @param props.children - What follows the total.
 * @returns The panel.
 */
function SentPanel({
  view,
  panel,
  title,
  children,
}: {
  view: CaseView;
  panel: VersionPanel;
  title: string;
  children?: ReactNode;
}) {
  return (
    <section className={styles.panel} aria-labelledby="sent-title">
      <h3 id="sent-title" className={styles.panelTitle}>
        {title}
      </h3>
      <VersionLines panel={panel} currency={view.currency} />
      <p className={styles.total}>{estimateTotal(panel.version.totals, view.currency)}</p>
      {children}
    </section>
  );
}

/**
 * The case's estimate (section 6, "a case, notes to estimate"): the notes
 * beside the draft with each line's span highlighted in them, the spans no
 * item matched and the lines left out, editing a line, and review and send;
 * then, once sent, the estimate as the owner has it.
 *
 * @param props - The case.
 * @param props.view - The case.
 * @returns The section's body.
 */
export function EstimateSection({ view }: { view: CaseView }) {
  const { draft, sent } = view.estimate;
  const state = view.money.state;
  const first = view.case.ownerFirstName;
  const caseId = view.case.id;

  if (draft) {
    return (
      <div className={styles.columns}>
        <NotesPanel view={view} panel={draft} canDraft={sent === null} />
        <DraftPanel view={view} draft={draft} />
      </div>
    );
  }
  if (!sent) {
    return (
      <div className={styles.columns}>
        <NotesPanel view={view} panel={null} canDraft />
        <section className={styles.panel} aria-labelledby="draft-title">
          <h3 id="draft-title" className={styles.panelTitle}>
            No estimate yet
          </h3>
          <p className={styles.muted}>
            Draft one from your notes, or add items from your price list.
          </p>
          <AddItemForm action={addLineAction.bind(null, caseId)} groups={itemOptions(view)} />
        </section>
      </div>
    );
  }
  const high = formatMoney({ pence: sent.version.totals.highPence, currency: view.currency });
  return (
    <div className={styles.columns}>
      <NotesPanel view={view} panel={sent} canDraft={false} />
      {state === "awaiting_owner" ? (
        <SentPanel
          view={view}
          panel={sent}
          title={`Sent to ${first}, version ${sent.version.number}`}
        >
          <p className={styles.muted}>
            Waiting for {first} to authorise the hold of {high}.
          </p>
          <div className={styles.actions}>
            <ActionDialog
              id="withdraw-estimate"
              trigger="Withdraw the estimate"
              triggerVariant="danger"
              title="Withdraw the estimate?"
              actionLabel="Withdraw it"
              actionVariant="danger"
              action={withdrawAction.bind(null, { caseId, what: "estimate" })}
            >
              <p className={styles.muted}>
                {first} won&apos;t be able to authorise it. Nothing is held yet, so nothing needs
                releasing. You can draft it again and send it.
              </p>
            </ActionDialog>
          </div>
        </SentPanel>
      ) : state === "withdrawn" ? (
        <SentPanel view={view} panel={sent} title={`Withdrawn, version ${sent.version.number}`}>
          <p className={styles.muted}>{first} can no longer authorise it.</p>
          <ActionButton action={draftAgainAction.bind(null, caseId)}>Draft it again</ActionButton>
        </SentPanel>
      ) : (
        <SentPanel
          view={view}
          panel={sent}
          title={`The estimate ${first} authorised, version ${sent.version.number}`}
        />
      )}
    </div>
  );
}
