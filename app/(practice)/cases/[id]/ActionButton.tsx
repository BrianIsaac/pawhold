"use client";

import { type ReactNode, useActionState } from "react";

import { Button, type ButtonVariant } from "../../../components/Button";
import { type FormState, NOTHING_YET } from "../../form-state";
import styles from "./case.module.css";

/**
 * One button that runs one action of the case page, its refusal shown beside it.
 *
 * @param props - The bound action, the label and the variant.
 * @param props.action - The action, bound to its target.
 * @param props.variant - The button's variant.
 * @param props.children - The label.
 * @returns The button in its form.
 */
export function ActionButton({
  action,
  variant = "primary",
  children,
}: {
  action: () => Promise<FormState>;
  variant?: ButtonVariant;
  children: ReactNode;
}) {
  const [state, submit, pending] = useActionState(action, NOTHING_YET);
  return (
    <form action={submit} className={styles.actions}>
      <Button type="submit" variant={variant} pending={pending}>
        {children}
      </Button>
      {state.message ? (
        <p role="alert" className={styles.notice}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
