"use client";

import { useActionState, useState } from "react";

import { Button } from "../../../../components/Button";
import { Dialog } from "../../../../components/Dialog";
import { SelectField, TextAreaField, TextField } from "../../../../components/Field";
import { type FormState, NOTHING_YET } from "../../../form-state";
import caseStyles from "../case.module.css";
import styles from "./discharge.module.css";

/** A charge the form offers: its id, its words, and what is left of it in pounds as typed. */
export interface ChargeChoice {
  readonly captureId: string;
  readonly label: string;
  /** What is left to refund, as the amount field starts ("577.00"). */
  readonly left: string;
}

/**
 * "Refund" after discharge (plan 3.2: goodwill or correction): which charge,
 * how much (all that is left of it to begin with) and why, in a dialog whose
 * button refunds.
 *
 * @param props - The owner's first name, the charges and the bound action.
 * @param props.ownerFirstName - The owner's first name.
 * @param props.charges - The charges that can still be refunded.
 * @param props.action - The refund action, bound to the case.
 * @returns The trigger and its dialog.
 */
export function RefundForm({
  ownerFirstName,
  charges,
  action,
}: {
  ownerFirstName: string;
  charges: readonly ChargeChoice[];
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const [state, submit, pending] = useActionState(action, NOTHING_YET);
  const [captureId, setCaptureId] = useState(state.values.captureId ?? charges[0]!.captureId);
  const [amount, setAmount] = useState(state.values.amount ?? charges[0]!.left);
  return (
    <div className={styles.refund}>
      <p className={caseStyles.muted}>
        Give back part or all of a charge, as goodwill or to correct the bill.
      </p>
      <div>
        <Dialog
          id="refund-dialog"
          trigger="Refund"
          triggerVariant="secondary"
          title={`Refund ${ownerFirstName}?`}
          action={
            <Button type="submit" form="refund-form" pending={pending}>
              Refund
            </Button>
          }
        >
          <form id="refund-form" action={submit} className={caseStyles.editorForm} noValidate>
            {state.message ? (
              <p role="alert" className={caseStyles.notice}>
                {state.message}
              </p>
            ) : null}
            <SelectField
              id="refund-charge"
              name="captureId"
              label="From"
              groups={[
                {
                  label: "Charged at discharge",
                  options: charges.map((one) => ({ value: one.captureId, label: one.label })),
                },
              ]}
              value={captureId}
              onChange={(event) => {
                setCaptureId(event.target.value);
                setAmount(charges.find((one) => one.captureId === event.target.value)?.left ?? "");
              }}
              error={state.fields.captureId}
            />
            <TextField
              id="refund-amount"
              name="amount"
              label="Amount"
              hint="In pounds, up to what is left of the charge."
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              error={state.fields.amount}
            />
            <TextAreaField
              id="refund-reason"
              name="reason"
              label="Why"
              hint="Kept on the case's timeline."
              rows={3}
              defaultValue={state.values.reason ?? ""}
              error={state.fields.reason}
            />
          </form>
        </Dialog>
      </div>
    </div>
  );
}
