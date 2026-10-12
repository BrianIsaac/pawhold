"use client";

import { type ReactNode, useRef } from "react";

import { Button, type ButtonVariant } from "./Button";
import styles from "./Dialog.module.css";

/** A dialog's props. */
export interface DialogProps {
  /** A page-unique id; the title's id is `{id}-title`. */
  readonly id: string;
  /** The trigger button's label. */
  readonly trigger: ReactNode;
  readonly triggerVariant?: ButtonVariant;
  /** Whether the trigger can be pressed. */
  readonly disabled?: boolean;
  /** The dialog's heading, which names it. */
  readonly title: ReactNode;
  readonly children: ReactNode;
}

/**
 * A modal dialog opened by its own button: the browser's `<dialog>`, which
 * keeps focus inside it, closes on Escape and returns focus to the trigger.
 * A form inside it closes it by submitting; "Cancel" closes it without.
 *
 * @param props - The id, the trigger, the title and the body.
 * @returns The trigger and the dialog.
 */
export function Dialog({
  id,
  trigger,
  triggerVariant = "primary",
  disabled,
  title,
  children,
}: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <Button
        variant={triggerVariant}
        aria-haspopup="dialog"
        aria-controls={id}
        disabled={disabled}
        onClick={() => dialog.current?.showModal()}
      >
        {trigger}
      </Button>
      <dialog id={id} ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`}>
        <div className={styles.body}>
          <h2 id={`${id}-title`} className={styles.title}>
            {title}
          </h2>
          {children}
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
