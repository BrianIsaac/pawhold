import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import styles from "./Field.module.css";

/** What every field takes: its name, its label, and its words of help or fault. */
interface FieldBase {
  readonly name: string;
  readonly label: ReactNode;
  /** The control's id; `field-{name}` by default. Give one when a page shows a name twice. */
  readonly id?: string;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
}

/** The ids and ARIA a control is given by its field. */
interface ControlWiring {
  readonly id: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: true;
}

/**
 * Works out a control's id and how its hint and error describe it.
 *
 * @param field - The field.
 * @returns The control's id and ARIA.
 */
function wiring(field: FieldBase): ControlWiring {
  const id = field.id ?? `field-${field.name}`;
  const describedBy = [
    field.hint === undefined ? null : `${id}-hint`,
    field.error === undefined ? null : `${id}-error`,
  ].filter((one): one is string => one !== null);
  return {
    id,
    ...(describedBy.length > 0 ? { "aria-describedby": describedBy.join(" ") } : {}),
    ...(field.error === undefined ? {} : { "aria-invalid": true as const }),
  };
}

/**
 * Splits a field's props into the field's own and the native control's.
 *
 * @param props - A field's props.
 * @returns The field, its control's wiring, and the props left for the control.
 */
function split<P extends FieldBase>(
  props: P,
): { field: FieldBase; wired: ControlWiring; control: Omit<P, keyof FieldBase> } {
  const { name, label, id, hint, error, ...control } = props;
  const field: FieldBase = {
    name,
    label,
    ...(id === undefined ? {} : { id }),
    ...(hint === undefined ? {} : { hint }),
    ...(error === undefined ? {} : { error }),
  };
  return { field, wired: wiring(field), control };
}

/**
 * The hint and error under a control.
 *
 * @param props - The field and the control's id.
 * @param props.field - The field.
 * @param props.id - The control's id.
 * @returns The words, or nothing.
 */
function Help({ field, id }: { field: FieldBase; id: string }) {
  return (
    <>
      {field.hint === undefined ? null : (
        <p id={`${id}-hint`} className={styles.hint}>
          {field.hint}
        </p>
      )}
      {field.error === undefined ? null : (
        <p id={`${id}-error`} className={styles.error}>
          {field.error}
        </p>
      )}
    </>
  );
}

/** A one-line text field's props. */
export interface TextFieldProps
  extends FieldBase, Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "name" | "className"> {}

/**
 * A labelled one-line text input.
 *
 * @param props - The field and the native input's props.
 * @returns The field.
 */
export function TextField(props: TextFieldProps) {
  const { field, wired, control } = split(props);
  const { type = "text", ...rest } = control;
  return (
    <div className={styles.field}>
      <label htmlFor={wired.id} className={styles.label}>
        {field.label}
      </label>
      <input type={type} name={field.name} className={styles.control} {...wired} {...rest} />
      <Help field={field} id={wired.id} />
    </div>
  );
}

/** A text area's props. */
export interface TextAreaFieldProps
  extends
    FieldBase,
    Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "name" | "className"> {}

/**
 * A labelled text area.
 *
 * @param props - The field and the native text area's props.
 * @returns The field.
 */
export function TextAreaField(props: TextAreaFieldProps) {
  const { field, wired, control } = split(props);
  const { rows = 5, ...rest } = control;
  return (
    <div className={styles.field}>
      <label htmlFor={wired.id} className={styles.label}>
        {field.label}
      </label>
      <textarea name={field.name} rows={rows} className={styles.control} {...wired} {...rest} />
      <Help field={field} id={wired.id} />
    </div>
  );
}

/** One option of a select. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** A group of a select's options, shown under its label. */
export interface SelectGroup {
  readonly label: string;
  readonly options: readonly SelectOption[];
}

/** A select's props: its options in groups, or a short list of them without. */
export type SelectFieldProps = FieldBase &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "name" | "className"> & {
    /** A first option with no value, such as "Choose an item". */
    readonly placeholder?: string;
  } & (
    | { readonly groups: readonly SelectGroup[]; readonly options?: never }
    | { readonly options: readonly SelectOption[]; readonly groups?: never }
  );

/**
 * The options of a select.
 *
 * @param props - The options.
 * @param props.options - The options, in order.
 * @returns One option element each.
 */
function Options({ options }: { options: readonly SelectOption[] }) {
  return options.map((option) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  ));
}

/**
 * A labelled select, its options in groups or in one list.
 *
 * @param props - The field, its options and the native select's props.
 * @returns The field.
 */
export function SelectField(props: SelectFieldProps) {
  const { field, wired, control } = split(props);
  const { groups, options, placeholder, ...rest } = control;
  return (
    <div className={styles.field}>
      <label htmlFor={wired.id} className={styles.label}>
        {field.label}
      </label>
      <select name={field.name} className={styles.control} {...wired} {...rest}>
        {placeholder === undefined ? null : <option value="">{placeholder}</option>}
        {options === undefined ? (
          groups?.map((group) => (
            <optgroup key={group.label} label={group.label}>
              <Options options={group.options} />
            </optgroup>
          ))
        ) : (
          <Options options={options} />
        )}
      </select>
      <Help field={field} id={wired.id} />
    </div>
  );
}

/** A checkbox's props. */
export interface CheckboxFieldProps
  extends
    FieldBase,
    Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "name" | "className" | "type"> {}

/**
 * A checkbox with its label beside it; the whole row is the tap target.
 *
 * @param props - The field and the native input's props.
 * @returns The field.
 */
export function CheckboxField(props: CheckboxFieldProps) {
  const { field, wired, control } = split(props);
  const rest = control;
  return (
    <div className={styles.field}>
      <label htmlFor={wired.id} className={styles.checkRow}>
        <input type="checkbox" name={field.name} className={styles.check} {...wired} {...rest} />
        <span>{field.label}</span>
      </label>
      <Help field={field} id={wired.id} />
    </div>
  );
}

/** The image types an update's photo may be (U4's `draftUpdate`). */
export const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** A file field's props. */
export interface FileFieldProps
  extends
    FieldBase,
    Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "name" | "className" | "type" | "accept"> {}

/**
 * A labelled file input for a photo.
 *
 * @param props - The field and the native input's props.
 * @returns The field.
 */
export function FileField(props: FileFieldProps) {
  const { field, wired, control } = split(props);
  const rest = control;
  return (
    <div className={styles.field}>
      <label htmlFor={wired.id} className={styles.label}>
        {field.label}
      </label>
      <input
        type="file"
        name={field.name}
        accept={PHOTO_TYPES.join(",")}
        className={styles.file}
        {...wired}
        {...rest}
      />
      <Help field={field} id={wired.id} />
    </div>
  );
}
