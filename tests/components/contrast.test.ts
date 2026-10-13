import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * Contrast AA on every chip tone (U11): each money state's ink on its
 * background, the two hold flags' ink on white, and the owner's "Held"
 * badge, read from the tokens themselves (WCAG 2's ratio; AA is 4.5:1 for
 * text this size). And every pair the restyle draws (U16, the mock-ups'
 * contrast table): text at 4.5:1, large text at 3:1, an edge at 3:1.
 */

/**
 * A CSS file's custom properties, each resolved to the hex colour it names,
 * through any `var()` it points at in the same file.
 *
 * @param path - The file.
 * @returns The colours.
 */
function colours(path: string): Map<string, string> {
  const raw = new Map<string, string>();
  for (const match of readFileSync(path, "utf8").matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)) {
    raw.set(match[1]!, match[2]!.trim().toLowerCase());
  }
  const resolve = (value: string | undefined, depth = 0): string | undefined => {
    const reference = value?.match(/^var\((--[a-z0-9-]+)\)$/);
    return reference && depth < 8 ? resolve(raw.get(reference[1]!), depth + 1) : value;
  };
  const found = new Map<string, string>();
  for (const name of raw.keys()) {
    const value = resolve(raw.get(name));
    if (value && /^#[0-9a-f]{6}$/.test(value)) {
      found.set(name, value);
    }
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

/**
 * A token's colour.
 *
 * @param name - The token, without its dashes ("colour-ink").
 * @returns "#rrggbb", or undefined when the token is missing.
 */
const token = (name: string): string => practice.get(`--${name}`)!;

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
  ["owner's Held badge", token("colour-accent-ink"), token("colour-accent")],
];

/** The restyle's pairs: what is drawn, its colour, its ground, and the ratio it needs. */
const RESTYLE: readonly (readonly [string, string, string, number])[] = [
  ["body ink on white", token("colour-ink"), token("colour-surface"), 4.5],
  ["body ink on mint (the practice's nav)", token("colour-ink"), token("colour-mint"), 4.5],
  ["body ink on sage", token("colour-ink"), token("colour-sage"), 4.5],
  ["body ink on the sandbox panel", token("colour-ink"), owner.get("--owner-warn-wash")!, 4.5],
  ["muted ink on white", token("colour-ink-muted"), token("colour-surface"), 4.5],
  [
    "muted ink on mint (the practice's name, the column heads)",
    token("colour-ink-muted"),
    token("colour-mint"),
    4.5,
  ],
  [
    "muted ink on the sandbox panel",
    token("colour-ink-muted"),
    owner.get("--owner-warn-wash")!,
    4.5,
  ],
  ["saddle on white (headings)", token("colour-saddle"), token("colour-surface"), 4.5],
  ["saddle on mint (the wordmark, large)", token("colour-saddle"), token("colour-mint"), 3],
  ["saddle on sage (the landing heading, large)", token("colour-saddle"), token("colour-sage"), 3],
  [
    "deep saddle on mint (a secondary button hovered)",
    token("colour-deep-saddle"),
    token("colour-mint"),
    4.5,
  ],
  ["white on pine (the main button)", token("colour-accent-ink"), token("colour-accent"), 4.5],
  [
    "white on deep pine (the main button hovered)",
    token("colour-accent-ink"),
    token("colour-accent-strong"),
    4.5,
  ],
  ["pine on sage (the owner's range)", token("colour-accent"), token("colour-sage"), 4.5],
  ["pine on white (links, quiet buttons)", token("colour-accent"), token("colour-surface"), 4.5],
  [
    "deep pine on white (patient links)",
    token("colour-accent-strong"),
    token("colour-surface"),
    4.5,
  ],
  ["success ink on white", token("colour-success-ink"), token("colour-surface"), 4.5],
  ["a field's edge on white", token("colour-line"), token("colour-surface"), 3],
  ["a secondary button's edge on white", token("colour-saddle"), token("colour-surface"), 3],
  ["the focus ring on white", token("colour-focus"), token("colour-surface"), 3],
  ["the focus ring on mint", token("colour-focus"), token("colour-mint"), 3],
  ["the focus ring on sage", token("colour-focus"), token("colour-sage"), 3],
  ["the owner's focus ring on white", owner.get("--owner-focus")!, token("colour-surface"), 3],
  ["the owner's focus ring on mint", owner.get("--owner-focus")!, token("colour-mint"), 3],
  // U18: the drawings, the owner's head panel, the thanks at "Held", the landing's band.
  [
    "the animal's name and species on the head panel (36 px and over, large)",
    token("colour-saddle"),
    token("colour-mint"),
    3,
  ],
  [
    "the owner's heading on the head panel (24 px, large)",
    token("colour-saddle"),
    token("colour-mint"),
    3,
  ],
  ["the head panel's sentence under the heading", token("colour-ink"), token("colour-mint"), 4.5],
  [
    "the practice's name on an update's head panel",
    token("colour-ink-muted"),
    token("colour-mint"),
    4.5,
  ],
  [
    "the thanks at Held (18 px, on the white card)",
    token("colour-saddle"),
    token("colour-surface"),
    4.5,
  ],
  [
    "a drawing's line on a mint disc or panel (a graphic)",
    token("colour-saddle"),
    token("colour-mint"),
    3,
  ],
  ["a drawing's line on white (a graphic)", token("colour-saddle"), token("colour-surface"), 3],
];

describe("contrast on every chip tone", () => {
  it.each(TONES)("%s: its ink is AA on its ground", (_tone, ink, ground) => {
    expect(ink, "a token is missing").toMatch(/^#[0-9a-f]{6}$/);
    expect(ground, "a token is missing").toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(ink, ground)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("contrast on every pair the restyle draws", () => {
  it.each(RESTYLE)("%s: %s on %s reaches %s:1", (_pair, ink, ground, needs) => {
    expect(ink, "a token is missing").toMatch(/^#[0-9a-f]{6}$/);
    expect(ground, "a token is missing").toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(ink, ground)).toBeGreaterThanOrEqual(needs);
  });
});
