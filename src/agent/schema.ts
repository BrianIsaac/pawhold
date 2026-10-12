import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { estimateLineInput, type EstimateLineInput } from "@/estimate/version";

import type { JsonSchema, StructuredFormat } from "./model";

export type { JsonSchema } from "./model";

const fields = estimateLineInput.shape;

/**
 * A line as the model drafts it: U2's line input, with no price by
 * construction, made strict for structured outputs. A strict schema has every
 * field required, so U2's optional dependency is nullable here, and the span
 * and the owner's wording, which 3.4 asks of every line, are required.
 */
export const draftedLine = z.strictObject({
  code: fields.code,
  quantityLow: fields.quantityLow,
  quantityHigh: fields.quantityHigh,
  dependsOn: fields.dependsOn.unwrap().nullable(),
  notesSpan: fields.notesSpan.unwrap(),
  ownerWording: fields.ownerWording.unwrap(),
});

export type DraftedLine = z.output<typeof draftedLine>;

/** A span of the notes the model found no price list item for. */
export const unmatchedSpan = z.strictObject({ notesSpan: z.string().min(1).max(2_000) });

/** The draft's answer: lines, and the spans no item matched (plan 3.4, job 1). */
export const draftAnswer = z.strictObject({
  lines: z.array(draftedLine),
  unmatched: z.array(unmatchedSpan),
});

/** The update's answer: the delta lines and the owner's explanation (plan 3.4, job 2). */
export const updateAnswer = z.strictObject({
  lines: z.array(draftedLine),
  explanation: z.string().max(1_200),
});

/**
 * The structured-output format for a schema: the OpenAI SDK's strict JSON
 * Schema, kept as plain JSON so a request can be hashed and recorded.
 *
 * @param schema - The answer's schema.
 * @param name - The format's name.
 * @returns The format.
 */
function formatOf(schema: z.ZodType, name: string): StructuredFormat {
  const format = zodTextFormat(schema, name);
  return {
    type: "json_schema",
    name,
    strict: true,
    schema: JSON.parse(JSON.stringify(format.schema)) as JsonSchema,
  };
}

/** The draft's structured-output format. */
export const DRAFT_FORMAT = formatOf(draftAnswer, "estimate_draft");

/** The update's structured-output format. */
export const UPDATE_FORMAT = formatOf(updateAnswer, "estimate_update");

/**
 * A drafted line as U2's line input: a null dependency becomes absent.
 *
 * @param line - The drafted line.
 * @returns The line input.
 */
export function toEstimateLine(line: DraftedLine): EstimateLineInput {
  const { dependsOn, ...rest } = line;
  return dependsOn === null ? rest : { ...rest, dependsOn };
}
