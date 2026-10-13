import { expect, type Locator } from "@playwright/test";

/*
 * The restyle's type (U16): Fraunces, the one web font, on the headings a
 * person is spoken to in, and the system stack everywhere else, so money
 * keeps its tabular figures. Read from what the browser drew.
 */

/** What a piece of text is set in. */
export interface SetIn {
  /** The first family of its computed `font-family`, unquoted. */
  readonly family: string;
  /** Whether a face of that family has loaded in the document. */
  readonly loaded: boolean;
  /** Its computed `font-variation-settings`. */
  readonly variation: string;
  /** Its computed `font-weight`. */
  readonly weight: string;
}

/**
 * What an element's text is set in, once the document's fonts have settled.
 *
 * @param element - The element.
 * @returns Its first family, whether that face loaded, its variation settings and weight.
 */
export async function setIn(element: Locator): Promise<SetIn> {
  return element.evaluate(async (node) => {
    await document.fonts.ready;
    const style = getComputedStyle(node);
    const family = style.fontFamily
      .split(",")[0]!
      .trim()
      .replace(/^["']|["']$/g, "");
    const loaded = [...document.fonts].some(
      (face) => face.family.replace(/^["']|["']$/g, "") === family && face.status === "loaded",
    );
    return {
      family,
      loaded,
      variation: style.fontVariationSettings,
      weight: style.fontWeight,
    };
  });
}

/**
 * Holds that an element is set in Fraunces as the restyle has it: loaded,
 * soft, never wonky, at 600.
 *
 * @param element - The element.
 * @returns Resolves when it holds.
 */
export async function expectFraunces(element: Locator): Promise<void> {
  const type = await setIn(element);
  expect(type.family, "the first family is Fraunces").toMatch(/Fraunces/);
  expect(type.family, "the first family is not the size-adjusted fallback").not.toMatch(
    /Fallback/i,
  );
  expect(type.loaded, `${type.family} has loaded`).toBe(true);
  expect(type.variation).toBe('"SOFT" 100, "WONK" 0');
  expect(type.weight).toBe("600");
}

/**
 * Holds that an element is set in the system stack, never the web font.
 *
 * @param element - The element.
 * @returns Resolves when it holds.
 */
export async function expectSystemStack(element: Locator): Promise<void> {
  expect((await setIn(element)).family).toBe("system-ui");
}
