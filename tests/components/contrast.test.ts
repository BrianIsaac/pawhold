import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * Contrast AA on every chip tone (U11): each money state's ink on its
 * background, the two hold flags' ink on white, and the owner's "Held"
 * badge, read from the tokens themselves (WCAG 2's ratio; AA is 4.5:1 for
 * text this size).
 */

/**
 * A CSS file's custom properties that hold a hex colour, by name.
 *
 * @param path - The file.
 * @returns The colours.
 */
function colours(path: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of readFileSync(path, "utf8").matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) {
    found.set(match[1]!, match[2]!.toLowerCase());
  }
  return found;
}

/**
 * WCAG 2's relative luminance of a hex colour.
 *
 * @param hex - "#rrggbb".
 * @returns The luminance.
 */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * WCAG 2's contrast ratio of two colours.
 *
 * @param one - A colour.
 * @param other - The other.
 * @returns The ratio, 1 to 21.
 */
function contrast(one: string, other: string): number {
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

const practice = colours("app/tokens.css");
const owner = colours("app/(owner)/owner.module.css");

/** Every chip tone: its ink and the ground it sits on. */
const TONES: readonly (readonly [string, string, string])[] = [
  ...[
    "estimate-draft",
    "awaiting-owner",
    "held",
    "update-awaiting-owner",
    "update-declined",
    "captured",
    "released",
    "refunded",
    "withdrawn",
    "extended",
    "honour-over",
  ].map(
    (tone) =>
      [tone, practice.get(`--money-${tone}-ink`)!, practice.get(`--money-${tone}-bg`)!] as const,
  ),
  ["seeded note", practice.get("--colour-notice-ink")!, practice.get("--colour-notice-soft")!],
  ["owner's Held badge", "#ffffff", owner.get("--owner-held")!],
  ["owner's held words", owner.get("--owner-held")!, owner.get("--owner-held-wash")!],
];

describe("contrast on every chip tone", () => {
  it.each(TONES)("%s: its ink is AA on its ground", (_tone, ink, ground) => {
    expect(ink, "a token is missing").toMatch(/^#[0-9a-f]{6}$/);
    expect(ground, "a token is missing").toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(ink, ground)).toBeGreaterThanOrEqual(4.5);
  });
});
