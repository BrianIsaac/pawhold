import { readFileSync } from "node:fs";

/*
 * Reads the README's testing instructions as a walk: each numbered step of a
 * section turned into the actions a stranger would take from its words. A
 * step's actions come from its own text, in order: an address in angle
 * brackets is opened; "click **X**" or "go to **X**" clicks what is named X;
 * "into **X**" types into the field named X; any other **X** or "X" must be
 * on the page; "fill in a patient, an owner and a procedure" fills the new
 * case's form. Words in brackets are an aside and are not walked. A step
 * with nothing to act on fails the walk, so the README and the pages cannot
 * drift apart unnoticed.
 */

/** The README at the repository's root. */
const README_URL = new URL("../../../README.md", import.meta.url);

/** One thing a step asks the reader to do or to see. */
export type StepAction =
  | { readonly kind: "open"; readonly url: string }
  | { readonly kind: "click"; readonly name: string; readonly inDialog: boolean }
  | { readonly kind: "type"; readonly field: string }
  | { readonly kind: "see"; readonly text: string }
  | { readonly kind: "new_case" }
  | { readonly kind: "paypal" };

/** A numbered step: its words and what they ask. */
export interface ReadmeStep {
  readonly number: number;
  readonly text: string;
  readonly actions: readonly StepAction[];
}

const TOKEN =
  /<(https?:\/\/[^>\s]+)>|(?:[Cc]lick|[Gg]o to)(?: the)? \*\*([^*]+)\*\*( button)?( again in the dialog)?|into \*\*([^*]+)\*\*|\*\*([^*]+)\*\*|"([^"]+)"|(fill in a patient, an owner and a procedure)/g;

/**
 * The numbered steps under a `###` heading of the README.
 *
 * @param heading - The section's heading, without the hashes.
 * @param text - The README's text; read from the repository by default.
 * @returns The steps, in order.
 * @throws Error when the section is missing or holds no numbered list.
 */
export function readmeSteps(
  heading: string,
  text: string = readFileSync(README_URL, "utf8"),
): ReadmeStep[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start < 0) {
    throw new Error(`the README has no section "${heading}"`);
  }
  const steps: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3} /.test(line)) {
      break;
    }
    const item = /^(\d+)\. (.*)$/.exec(line);
    if (item) {
      steps.push(item[2]!);
    } else if (/^\s+\S/.test(line) && steps.length > 0) {
      steps[steps.length - 1] += ` ${line.trim()}`;
    }
  }
  if (steps.length === 0) {
    throw new Error(`the README's "${heading}" has no numbered steps`);
  }
  return steps.map((step, at) => ({ number: at + 1, text: step, actions: stepActions(step) }));
}

/**
 * What one step's words ask, in the order they ask it.
 *
 * @param step - The step's words.
 * @returns The actions.
 * @throws Error when the step asks nothing a walk can do.
 */
export function stepActions(step: string): StepAction[] {
  const walked = step.replace(/\([^)]*\)/g, "");
  const paypal = walked.includes("PayPal's window");
  const actions: StepAction[] = [];
  for (const match of walked.matchAll(TOKEN)) {
    const [, url, clicked, , again, field, named, quoted, newCase] = match;
    if (url) {
      actions.push({ kind: "open", url });
    } else if (clicked) {
      actions.push(
        paypal && clicked === "PayPal"
          ? { kind: "paypal" }
          : { kind: "click", name: clicked, inDialog: Boolean(again) },
      );
    } else if (field) {
      actions.push({ kind: "type", field });
    } else if (named ?? quoted) {
      actions.push({ kind: "see", text: (named ?? quoted)! });
    } else if (newCase) {
      actions.push({ kind: "new_case" });
    }
  }
  if (actions.length === 0) {
    throw new Error(`the README step "${step}" asks nothing a walk can do`);
  }
  return actions;
}
