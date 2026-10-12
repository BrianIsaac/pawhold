"use client";

import { type ReactNode, useActionState } from "react";

import { Button, type ButtonVariant } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { type FormState, NOTHING_YET } from "../../form-state";
import styles from "./case.module.css";

/**
 * A dialog that confirms one action of the case page (review and send,
 * withdraw): its body says what will happen, its button does it.
 *
 * @param props - The dialog's id, trigger, title, body, the action's label and the bound action.
 * @param props.id - A page-unique id.
 * @param props.trigger - The trigger's label.
 * @param props.triggerVariant - The trigger's variant.
 * @param props.title - The dialog's heading.
 * @param props.actionLabel - The confirming button's label.
 * @param props.actionVariant - The confirming button's variant.
 * @param props.action - The action, bound to its target.
 * @param props.disabled - Whether the trigger can be pressed.
 * @param props.children - The body.
 * @returns The trigger and its dialog.
 */
export function ActionDialog({
  id,
  trigger,
  triggerVariant = "primary",
  title,
  actionLabel,
  actionVariant = "primary",
  action,
  disabled,
  children,
}: {
  id: string;
  trigger: ReactNode;
  triggerVariant?: ButtonVariant;
  title: ReactNode;
  actionLabel: ReactNode;
  actionVariant?: ButtonVariant;
  action: () => Promise<FormState>;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [state, submit, pending] = useActionState(action, NOTHING_YET);
  return (
    <Dialog
      id={id}
      trigger={trigger}
      triggerVariant={triggerVariant}
      title={title}
      {...(disabled === undefined ? {} : { disabled })}
      action={
        <Button type="submit" form={`${id}-form`} variant={actionVariant} pending={pending}>
          {actionLabel}
        </Button>
      }
    >
      <form id={`${id}-form`} action={submit} className={styles.editorForm}>
        {state.message ? (
          <p role="alert" className={styles.notice}>
            {state.message}
          </p>
        ) : null}
        {children}
      </form>
    </Dialog>
  );
}
