"use client";

import { useActionState } from "react";

import {
  DRAFT_UPDATE_BUTTON,
  FINDING_LABEL,
  PHOTO_LABEL,
  REDRAFT_WARNING,
  SHARE_PHOTO_LABEL,
} from "@/practice/wording";

import { Button } from "../../../components/Button";
import { CheckboxField, FileField, TextAreaField } from "../../../components/Field";
import { type FormState, NOTHING_YET } from "../../form-state";
import styles from "./case.module.css";

/**
 * The update's form (section 6): what the vet found and recommends, an
 * optional photo, and whether the owner sees it.
 *
 * @param props - The bound draft action, the finding to start from, and whether an update draft has lines.
 * @param props.action - The update's draft action, bound to the case.
 * @param props.defaultFinding - The finding the open update was drafted from, if any.
 * @param props.redraft - Whether pressing it replaces an update draft's lines.
 * @returns The form.
 */
export function UpdateForm({
  action,
  defaultFinding,
  redraft,
}: {
  action: (previous: FormState, form: FormData) => Promise<FormState>;
  defaultFinding: string;
  redraft: boolean;
}) {
  const [state, submit, pending] = useActionState(action, NOTHING_YET);
  return (
    <form action={submit} className={styles.editorForm} noValidate>
      {state.message && Object.keys(state.fields).length === 0 ? (
        <p role="alert" className={styles.notice}>
          {state.message}
        </p>
      ) : null}
      <TextAreaField
        name="finding"
        label={FINDING_LABEL}
        rows={5}
        defaultValue={state.values.finding ?? defaultFinding}
        error={state.fields.finding}
        hint={redraft ? REDRAFT_WARNING : undefined}
      />
      <FileField
        name="photo"
        label={PHOTO_LABEL}
        hint="PNG, JPEG, WebP or GIF, at most 5 MB"
        error={state.fields.photo}
      />
      <CheckboxField
        name="sharePhoto"
        label={SHARE_PHOTO_LABEL}
        defaultChecked={state.values.sharePhoto === "on"}
        error={state.fields.sharePhoto}
      />
      <div className={styles.actions}>
        <Button type="submit" pending={pending}>
          {DRAFT_UPDATE_BUTTON}
        </Button>
      </div>
    </form>
  );
}
