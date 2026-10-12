"use client";

import { type ReactNode, useActionState } from "react";

import { Button, type ButtonVariant } from "../../components/Button";
import { type FormState, NOTHING_YET } from "../form-state";
import styles from "./day.module.css";

/**
 * One of the day's buttons (Undo, Move it, Dismiss), bound to its proposal,
 * described by the words it answers, its refusal shown beside it.
 *
 * @param props - The bound action, the variant, its full name, what describes it and the label.
 * @param props.action - The action, bound to its proposal.
 * @param props.variant - The button's variant.
 * @param props.name - Its accessible name: the label, then whose it is, so two holds' buttons differ.
 * @param props.describedBy - The id of the sentence the button answers.
 * @param props.children - The label.
 * @returns The button in its form.
 */
export function DayActionButton({
  action,
  variant = "primary",
  name,
  describedBy,
  children,
}: {
  action: () => Promise<FormState>;
  variant?: ButtonVariant;
  name: string;
  describedBy: string;
  children: ReactNode;
}) {
  const [state, submit, pending] = useActionState(action, NOTHING_YET);
  return (
    <form action={submit} className={styles.buttonForm}>
      <Button
        type="submit"
        variant={variant}
        pending={pending}
        aria-label={name}
        aria-describedby={describedBy}
      >
        {children}
      </Button>
      {state.message ? (
        <p role="alert" className={styles.refusal}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
