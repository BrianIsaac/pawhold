"use client";

import { useActionState } from "react";

import { Button } from "../../../components/Button";
import { SelectField, TextField } from "../../../components/Field";
import { type FormState, NOTHING_YET } from "../../form-state";
import styles from "./case.module.css";

/**
 * Adds an item from the practice's price list by hand (section 6: "Add items
 * from your price list below"); the hand path is complete without the model.
 *
 * @param props - The bound add action and the list, grouped.
 * @param props.action - The add action, bound to the case.
 * @param props.groups - The price list by category, each item's label priced.
 * @returns The form.
 */
export function AddItemForm({
  action,
  groups,
}: {
  action: (previous: FormState, form: FormData) => Promise<FormState>;
  groups: readonly { label: string; options: readonly { value: string; label: string }[] }[];
}) {
  const [state, submit, pending] = useActionState(action, NOTHING_YET);
  return (
    <form action={submit} className={styles.editorForm} noValidate>
      <h3 className={styles.subTitle}>Add an item from your price list</h3>
      {state.message ? (
        <p role="alert" className={styles.notice}>
          {state.message}
        </p>
      ) : null}
      <SelectField
        id="add-code"
        name="code"
        label="Item"
        placeholder="Choose an item"
        groups={groups}
        defaultValue={state.values.code ?? ""}
        error={state.fields.code}
      />
      <fieldset className={styles.quantities}>
        <legend>Quantity</legend>
        <TextField
          id="add-low"
          name="quantityLow"
          label="Least"
          inputMode="numeric"
          defaultValue={state.values.quantityLow ?? "1"}
          error={state.fields.quantityLow}
        />
        <TextField
          id="add-high"
          name="quantityHigh"
          label="Most"
          inputMode="numeric"
          defaultValue={state.values.quantityHigh ?? "1"}
          error={state.fields.quantityHigh}
        />
      </fieldset>
      <div className={styles.actions}>
        <Button type="submit" variant="secondary" pending={pending}>
          Add the item
        </Button>
      </div>
    </form>
  );
}
