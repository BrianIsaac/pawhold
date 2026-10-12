import type { Route } from "next";
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import styles from "./Button.module.css";

/** How loud a button is: one primary action per area, the rest secondary or quiet. */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

/** A button's own props, beside the native ones. */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant?: ButtonVariant;
  /** While its action runs: disabled and announced as busy. */
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
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={styles.button}
      data-variant={variant}
      disabled={disabled === true || pending}
      aria-busy={pending ? true : undefined}
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
    </Link>
  );
}
