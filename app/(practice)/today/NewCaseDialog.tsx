"use client";

import { useActionState } from "react";

import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { CHOOSE_SPECIES, SPECIES_OPTIONS } from "@/practice/species";

import { SelectField, TextField } from "../../components/Field";
import { openCaseAction } from "../actions";
import { NOTHING_YET } from "../form-state";
import styles from "../practice.module.css";

/**
 * Today's "New case": a dialog with the case's patient and its species (U17),
 * owner, procedure and vet. Section 6 drafts none of these words: they are
 * this unit's (D11).
 *
 * @param props - The vet the practice used last, to start the field with.
 * @param props.defaultVet - That vet's name, or the empty string.
 * @returns The trigger and its dialog.
 */
export function NewCaseDialog({ defaultVet }: { defaultVet: string }) {
  const [state, action, pending] = useActionState(openCaseAction, NOTHING_YET);
  return (
    <Dialog
      id="new-case"
      trigger="New case"
      title="Open a case"
      action={
        <Button type="submit" form="new-case-form" pending={pending}>
          Open the case
        </Button>
      }
    >
      <form id="new-case-form" action={action} className={styles.formGrid} noValidate>
        {state.message ? (
          <p role="alert" className={styles.alert}>
            {state.message}
          </p>
        ) : null}
        <TextField
          name="patientName"
          defaultValue={state.values.patientName}
          label="Patient"
          autoComplete="off"
          required
          error={state.fields.patientName}
        />
        <SelectField
          name="species"
          label="Species"
          placeholder={CHOOSE_SPECIES}
          options={SPECIES_OPTIONS}
          defaultValue={state.values.species ?? ""}
          required
          error={state.fields.species}
        />
        <TextField
          name="ownerName"
          defaultValue={state.values.ownerName}
          label="Owner"
          autoComplete="off"
          required
          error={state.fields.ownerName}
        />
        <TextField
          name="procedure"
          defaultValue={state.values.procedure}
          label="Procedure"
          hint="What the animal is in for, as the practice names it"
          autoComplete="off"
          required
          error={state.fields.procedure}
        />
        <TextField
          name="vetName"
          label="Vet"
          hint="The vet whose name the estimate is approved under"
          autoComplete="off"
          required
          defaultValue={state.values.vetName ?? defaultVet}
          error={state.fields.vetName}
        />
      </form>
    </Dialog>
  );
}
