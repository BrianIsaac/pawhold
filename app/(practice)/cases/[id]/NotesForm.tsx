"use client";

import { useActionState } from "react";

import { DRAFT_BUTTON, NOTES_LABEL, NOTES_PLACEHOLDER, REDRAFT_WARNING } from "@/practice/wording";

import { Button } from "../../../components/Button";
import { TextAreaField } from "../../../components/Field";
import { type FormState, NOTHING_YET } from "../../form-state";
import styles from "./case.module.css";

/**
 * The notes box and "Draft estimate" (section 6). With a draft open, it says
 * first that drafting again replaces the draft's lines.
 *
 * @param props - The bound draft action, the notes to start from, and whether a draft has lines.
 * @param props.action - The draft action, bound to the case.
 * @param props.defaultNotes - The notes the draft was made from, if any.
 * @param props.redraft - Whether pressing it replaces lines.
 * @returns The form.
 */
export function NotesForm({
  action,
  defaultNotes,
  redraft,
}: {
  action: (previous: FormState, form: FormData) => Promise<FormState>;
  defaultNotes: string;
  redraft: boolean;
}) {
  const [state, submit, pending] = useActionState(action, NOTHING_YET);
  return (
    <form action={submit} className={styles.editorForm} noValidate>
      {state.message ? (
        <p role="alert" className={styles.notice}>
          {state.message}
        </p>
      ) : null}
      <TextAreaField
        name="notes"
        label={NOTES_LABEL}
        placeholder={NOTES_PLACEHOLDER}
        rows={6}
        defaultValue={state.values.notes ?? defaultNotes}
        error={state.fields.notes}
        hint={redraft ? REDRAFT_WARNING : undefined}
      />
      <div className={styles.actions}>
        <Button type="submit" pending={pending}>
          {DRAFT_BUTTON}
        </Button>
      </div>
    </form>
  );
}
