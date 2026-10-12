import type { Route } from "next";
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./Button.module.css";
import { LinkPending } from "./LinkPending";

/** How loud a button is: one primary action per area, the rest secondary or quiet. */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

/** A button's own props, beside the native ones. */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant?: ButtonVariant;
  /**
   * While its action runs: announced as busy and disabled to assistive
   * technology, its presses ignored; it keeps focus, which a disabled button
   * would drop.
   */
  readonly pending?: boolean;
  readonly children: ReactNode;
}

/**
 * A button at least 44 px each way. It is `type="button"` unless told to
 * submit, so a button in a form never sends it by accident.
 *
 * @param props - The variant, whether it is pending, and the native props.
 * @returns The button.
 */
export function Button({
  variant = "primary",
  pending = false,
  type = "button",
  disabled,
  onClick,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={styles.button}
      data-variant={variant}
      disabled={disabled}
      aria-disabled={pending ? true : undefined}
      aria-busy={pending ? true : undefined}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A link drawn as a button. */
export interface ButtonLinkProps {
  readonly href: Route;
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}

/**
 * A link that looks like a button, for an action that goes to another page.
 *
 * @param props - Where it goes, its variant and its label.
 * @returns The link.
 */
export function ButtonLink({ href, variant = "primary", children }: ButtonLinkProps) {
  return (
    <Link href={href} className={styles.button} data-variant={variant}>
      {children}
      <LinkPending />
    </Link>
  );
}
