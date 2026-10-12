/**
 * What a practice form's action answers when it does not move on: why, each
 * field's fault, and what was typed, since React resets a form after its
 * action and the fields start again from what is given back here.
 */
export interface FormState {
  readonly message: string | null;
  readonly fields: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, string>>;
}

/** A form not yet sent. */
export const NOTHING_YET: FormState = { message: null, fields: {}, values: {} };

/**
 * The text fields of a form, to give back to it.
 *
 * @param form - The form.
 * @param names - The fields to give back.
 * @returns Each field's text by name.
 */
export function formValues(form: FormData, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, formText(form, name)]));
}

/**
 * A form field's text, or the empty string when it is missing or a file.
 *
 * @param form - The form.
 * @param name - The field's name.
 * @returns The text.
 */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
