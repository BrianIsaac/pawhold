import { describe, expect, it } from "vitest";

import {
  DRAFT_FORMAT,
  draftedLine,
  toEstimateLine,
  UPDATE_FORMAT,
  type JsonSchema,
} from "@/agent/schema";
import { estimateLineInput } from "@/estimate/version";

/**
 * Every object schema in a JSON Schema, with the path it sits at.
 *
 * @param schema - The schema.
 * @param path - Where it sits.
 * @returns Each object schema and its path.
 */
function objectsOf(schema: unknown, path = "$"): { path: string; schema: JsonSchema }[] {
  if (typeof schema !== "object" || schema === null) {
    return [];
  }
  const node = schema as JsonSchema;
  const found = node.type === "object" ? [{ path, schema: node }] : [];
  return [
    ...found,
    ...Object.entries(node).flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.flatMap((item, index) => objectsOf(item, `${path}.${key}[${index}]`))
        : objectsOf(value, `${path}.${key}`),
    ),
  ];
}

describe("the structured-output schema, made from U2's line input", () => {
  // Plan 3.4: "The schema has no price field."
  it.each([
    ["draft", DRAFT_FORMAT.schema],
    ["update", UPDATE_FORMAT.schema],
  ])("the %s schema has no price field", (_job, schema) => {
    const keys = objectsOf(schema).flatMap(({ schema: node }) =>
      Object.keys((node.properties as Record<string, unknown> | undefined) ?? {}),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(/price|pence|amount|total|cost/i);
    }
  });

  it.each([
    ["draft", DRAFT_FORMAT.schema],
    ["update", UPDATE_FORMAT.schema],
  ])("the %s schema is strict: every object closed and every field required", (_job, schema) => {
    const objects = objectsOf(schema);
    expect(objects.length).toBeGreaterThan(1);
    for (const { path, schema: node } of objects) {
      expect(node.additionalProperties, path).toBe(false);
      expect([...((node.required as string[] | undefined) ?? [])].sort(), path).toEqual(
        Object.keys(node.properties as Record<string, unknown>).sort(),
      );
    }
  });

  it("asks for a line's code in the price list's own code shape", () => {
    const line = objectsOf(DRAFT_FORMAT.schema).find(({ schema: node }) =>
      Object.hasOwn(node.properties as object, "code"),
    )!.schema;
    const code = (line.properties as Record<string, JsonSchema>).code!;
    expect(code.pattern).toBe("^[A-Z0-9]+(-[A-Z0-9]+)*$");
    expect(Object.keys(line.properties as object)).toEqual([
      "code",
      "quantityLow",
      "quantityHigh",
      "dependsOn",
      "notesSpan",
      "ownerWording",
    ]);
  });

  it("names each format for the request and marks it strict", () => {
    expect(DRAFT_FORMAT).toMatchObject({
      type: "json_schema",
      name: "estimate_draft",
      strict: true,
    });
    expect(UPDATE_FORMAT).toMatchObject({
      type: "json_schema",
      name: "estimate_update",
      strict: true,
    });
  });

  it("asks the update for the owner's explanation and the draft for unmatched spans", () => {
    expect(Object.keys(UPDATE_FORMAT.schema.properties as object)).toEqual([
      "lines",
      "explanation",
    ]);
    expect(Object.keys(DRAFT_FORMAT.schema.properties as object)).toEqual(["lines", "unmatched"]);
  });
});

describe("a drafted line as U2's line input", () => {
  it("drops a null dependency, so U2 reads it as absent", () => {
    const drafted = draftedLine.parse({
      code: "LAB-PRE",
      quantityLow: 1,
      quantityHigh: 1,
      dependsOn: null,
      notesSpan: "pre-op bloods",
      ownerWording: "A blood test before the anaesthetic",
    });
    const line = toEstimateLine(drafted);
    expect(line).toEqual({
      code: "LAB-PRE",
      quantityLow: 1,
      quantityHigh: 1,
      notesSpan: "pre-op bloods",
      ownerWording: "A blood test before the anaesthetic",
    });
    expect(estimateLineInput.safeParse(line).success).toBe(true);
  });

  it("keeps a dependency", () => {
    const line = toEstimateLine(
      draftedLine.parse({
        code: "DEN-EXT-SG",
        quantityLow: 0,
        quantityHigh: 2,
        dependsOn: "extractions are needed",
        notesSpan: "probable two extractions upper PM",
        ownerWording: "Removing up to two teeth, if needed",
      }),
    );
    expect(line.dependsOn).toBe("extractions are needed");
  });

  it("refuses a line given a price, as U2 does", () => {
    expect(
      draftedLine.safeParse({
        code: "LAB-PRE",
        quantityLow: 1,
        quantityHigh: 1,
        dependsOn: null,
        notesSpan: "pre-op bloods",
        ownerWording: "A blood test",
        unitPricePence: 100,
      }).success,
    ).toBe(false);
  });
});
