import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * One set of colours (U16): a colour is written as a literal in
 * app/tokens.css and nowhere else, except where the thing drawing it cannot
 * read the page's CSS (PayPal's card frames, the phone's theme colour, the
 * icon) or the owner's own warning, error and focus colours; each of those
 * literals is a token's value. The colours the restyle replaced are gone.
 */

const TOKENS = "app/tokens.css";
const OWNER = "app/(owner)/owner.module.css";

/** Every hex colour, and every `rgb()` or `rgba()` colour, in a text. */
const LITERAL = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\(\s*\d+[\s,]+\d+[\s,]+\d+/gi;

/**
 * Every file under a folder whose colours are checked.
 *
 * @param folder - The folder.
 * @returns The paths.
 */
function sources(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(css|ts|tsx|svg)$/.test(path))
    .map((path) => join(folder, path));
}

/**
 * A colour literal as its red, green and blue, ignoring any alpha.
 *
 * @param literal - "#rgb", "#rrggbb", "#rrggbbaa", or the start of an `rgb()`.
 * @returns "r g b", in decimal.
 */
function channels(literal: string): string {
  if (literal.startsWith("#")) {
    const hex =
      literal.length === 4 ? [...literal.slice(1)].map((c) => c + c).join("") : literal.slice(1, 7);
    return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(" ");
  }
  return literal
    .replace(/^rgba?\(/i, "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .join(" ");
}

/** The colours app/tokens.css names, as their channels. */
const TOKEN_COLOURS = new Set(
  [...readFileSync(TOKENS, "utf8").matchAll(/--[a-z0-9-]+:\s*([^;]+);/gi)].flatMap((match) =>
    [...match[1]!.matchAll(LITERAL)].map((literal) => channels(literal[0])),
  ),
);

/** The owner's own warning, error and focus colours, kept apart (decision in U16's handover). */
const OWNER_OWN = new Set(["#8a4b00", "#fdf1e1", "#a1261b", "#fbe9e7", "#1f5fbf"].map(channels));

const found = sources("app")
  .filter((path) => path !== TOKENS)
  .flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(LITERAL)].map((match) => ({ path, literal: match[0] })),
  );

describe("colours outside the token set", () => {
  it("are each a token's value", () => {
    const strays = found.filter(
      ({ path, literal }) =>
        !TOKEN_COLOURS.has(channels(literal)) &&
        !(path === OWNER && OWNER_OWN.has(channels(literal))),
    );
    expect(strays).toEqual([]);
  });

  it.each([
    ["the owner's old field edge", "#847d72"],
    ["the owner's old placeholder", "#6b655d"],
    ["the owner's old ink", "#1d2327"],
    ["the owner's old paper", "#f7f5f0"],
    ["the old ink, in a backdrop or shadow", "rgb(26 31 36"],
    ["the old accent", "#0b6560"],
  ])("leave none of %s (%s)", (_name, literal) => {
    expect(found.filter((at) => channels(at.literal) === channels(literal))).toEqual([]);
  });

  it.each([
    ["app/(owner)/e/[token]/authorise.tsx", "#91785d", "the card fields' edge, taupe"],
    ["app/(owner)/e/[token]/authorise.tsx", "#6a5744", "their placeholder, taupe ink"],
    ["app/(owner)/e/[token]/authorise.tsx", "#342313", "their words, espresso"],
    ["app/(owner)/layout.tsx", "#bbe1c3", "the phone's theme colour, mint"],
    ["app/icon.svg", "#8b5d33", "the icon's tile, saddle"],
    ["app/icon.svg", "#bbe1c3", "the icon's paw, mint"],
  ])("%s draws %s: %s", (path, literal) => {
    expect(readFileSync(path, "utf8").toLowerCase()).toContain(literal);
  });
});
