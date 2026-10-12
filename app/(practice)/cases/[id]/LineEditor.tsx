"use client";

import { useActionState } from "react";

import { Button } from "../../../components/Button";
import { TextField } from "../../../components/Field";
import { type FormState, NOTHING_YET } from "../../form-state";
import styles from "./case.module.css";

/** The line a {@link LineEditor} changes, as it stands. */
export interface EditableLine {
  readonly position: number;
  readonly name: string;
  readonly quantityLow: number;
  readonly quantityHigh: number;
  readonly dependsOn: string | null;
  readonly ownerWording: string | null;
}

/**
 * "Edit a line": the line's quantities, its condition ("Only if") and the
 * owner's wording, saved or the line removed. Words are this unit's (D11).
 *
 * @param props - The line and its bound save and remove actions.
 * @param props.line - The line.
 * @param props.save - Saves the line's fields.
 * @param props.remove - Takes the line out.
 * @returns The editor, folded until opened.
 */
export function LineEditor({
  line,
  save,
  remove,
}: {
  line: EditableLine;
  save: (previous: FormState, form: FormData) => Promise<FormState>;
  remove: () => Promise<FormState>;
}) {
  const [saved, saveAction, saving] = useActionState(save, NOTHING_YET);
  const [removed, removeAction, removing] = useActionState(remove, NOTHING_YET);
  const id = `line-${line.position}`;
  const message = saved.message ?? removed.message;
  return (
    <details className={styles.editor} open={saved.message !== null || undefined}>
      <summary className={styles.editorSummary}>
        Change line {line.position}
        <span className="visually-hidden">: {line.name}</span>
      </summary>
      <form action={saveAction} className={styles.editorForm} noValidate>
        {message ? (
          <p role="alert" className={styles.notice}>
            {message}
          </p>
        ) : null}
        <fieldset className={styles.quantities}>
          <legend>Quantity</legend>
          <TextField
            id={`${id}-low`}
            name="quantityLow"
            label="Least"
            inputMode="numeric"
            defaultValue={saved.values.quantityLow ?? String(line.quantityLow)}
            error={saved.fields.quantityLow}
          />
          <TextField
            id={`${id}-high`}
            name="quantityHigh"
            label="Most"
            inputMode="numeric"
            defaultValue={saved.values.quantityHigh ?? String(line.quantityHigh)}
            error={saved.fields.quantityHigh}
          />
        </fieldset>
        <TextField
          id={`${id}-depends`}
          name="dependsOn"
          label="Only if"
          hint="Leave empty when the line is always needed"
          defaultValue={saved.values.dependsOn ?? line.dependsOn ?? ""}
          error={saved.fields.dependsOn}
        />
        <TextField
          id={`${id}-wording`}
          name="ownerWording"
          label="What the owner reads"
          hint="Leave empty to show the item's own name"
          defaultValue={saved.values.ownerWording ?? line.ownerWording ?? ""}
          error={saved.fields.ownerWording}
        />
        <div className={styles.actions}>
          <Button type="submit" pending={saving}>
            Save line {line.position}
          </Button>
          <Button variant="danger" formAction={removeAction} pending={removing}>
            Remove line {line.position}
          </Button>
        </div>
      </form>
    </details>
  );
}
