import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Wordmark } from "../../app/components/Wordmark";

/**
 * The shapes of a paw drawing: its tile and each pad, in order, without colours.
 *
 * @param svg - The drawing's markup.
 * @returns Each shape's tag and geometry.
 */
function shapes(svg: string): string[] {
  return [...svg.matchAll(/<(rect|ellipse|circle)\b([^>]*?)\/?>/g)].map(
    ([, tag, attributes]) =>
      `${tag} ${[...attributes!.matchAll(/\b(width|height|rx|ry|cx|cy|r)="([^"]+)"/g)]
        .map(([, name, value]) => `${name}=${value}`)
        .join(" ")}`,
  );
}

describe("Wordmark", () => {
  it("reads as pawhold, its paw tile hidden from assistive technology", () => {
    const html = renderToStaticMarkup(<Wordmark />);

    expect(html.replace(/<svg[\s\S]*<\/svg>/, "")).toMatch(/>pawhold<\/span>$/);
    expect(html).toMatch(/<svg [^>]*aria-hidden="true"[^>]*focusable="false"/);
  });

  it("draws the icon's paw, shape for shape", () => {
    const html = renderToStaticMarkup(<Wordmark />);

    const icon = shapes(readFileSync("app/icon.svg", "utf8"));
    expect(icon).toHaveLength(6);
    expect(shapes(html)).toEqual(icon);
  });
});
