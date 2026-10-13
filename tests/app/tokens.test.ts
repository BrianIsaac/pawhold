import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * The restyle's tokens (U16): the owner's five colours by name, the app's
 * tokens re-pointed at them as the approved mock-ups have them, and what the
 * restyle must never touch: the money states, the focus ring and the
 * feedback colours, each held at the value it had before.
 */

/**
 * A CSS file's custom properties and their values, by name.
 *
 * @param path - The file.
 * @returns The values, trimmed and lower-cased.
 */
function properties(path: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of readFileSync(path, "utf8").matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)) {
    found.set(match[1]!, match[2]!.replace(/\s+/g, " ").trim().toLowerCase());
  }
  return found;
}

const tokens = properties("app/tokens.css");

/** The money states, their flags, the focus ring and feedback, as they were before the restyle. */
const UNTOUCHED: Readonly<Record<string, string>> = {
  "--money-estimate-draft-bg": "#e9ecef",
  "--money-estimate-draft-ink": "#343d45",
  "--money-awaiting-owner-bg": "#fff0c4",
  "--money-awaiting-owner-ink": "#5c4100",
  "--money-held-bg": "#dce9fb",
  "--money-held-ink": "#133f78",
  "--money-update-awaiting-owner-bg": "#ffe2c7",
  "--money-update-awaiting-owner-ink": "#6e3300",
  "--money-update-declined-bg": "#fbe0dc",
  "--money-update-declined-ink": "#7e1f16",
  "--money-captured-bg": "#d8f0df",
  "--money-captured-ink": "#135229",
  "--money-released-bg": "#d4efec",
  "--money-released-ink": "#0a4a45",
  "--money-refunded-bg": "#ebe2f8",
  "--money-refunded-ink": "#45297c",
  "--money-withdrawn-bg": "#ebebeb",
  "--money-withdrawn-ink": "#3d3d3d",
  "--money-extended-bg": "#ffffff",
  "--money-extended-ink": "#133f78",
  "--money-honour-over-bg": "#ffffff",
  "--money-honour-over-ink": "#7e1f16",
  "--colour-focus": "#1d5fbf",
  "--colour-danger": "#a12a1f",
  "--colour-danger-strong": "#7e1f16",
  "--colour-danger-soft": "#fbe5e2",
  "--colour-notice-soft": "#fff4d6",
  "--colour-notice-ink": "#5c4300",
  "--colour-success-soft": "#dff3e6",
  "--colour-success-ink": "#155a2d",
};

/** The owner's five, at their own values, and the inks derived from them. */
const NAMED: Readonly<Record<string, string>> = {
  "--colour-mint": "#bbe1c3",
  "--colour-sage": "#a7cdbd",
  "--colour-moss": "#869d7a",
  "--colour-taupe": "#91785d",
  "--colour-saddle": "#8b5d33",
  "--colour-espresso": "#342313",
  "--colour-taupe-ink": "#6a5744",
  "--colour-deep-saddle": "#704b29",
  "--colour-pine": "#28483b",
  "--colour-deep-pine": "#213b30",
};

/** The app's tokens, re-pointed at the named colours (the mock-ups' `restyle.css` section 1). */
const REPOINTED: Readonly<Record<string, string>> = {
  "--colour-ink": "var(--colour-espresso)",
  "--colour-ink-muted": "var(--colour-taupe-ink)",
  "--colour-surface": "#ffffff",
  "--colour-canvas": "#ffffff",
  "--colour-line": "var(--colour-taupe)",
  "--colour-line-soft": "var(--colour-mint)",
  "--colour-edge": "var(--colour-sage)",
  "--colour-accent": "var(--colour-pine)",
  "--colour-accent-strong": "var(--colour-deep-pine)",
  "--colour-accent-ink": "#ffffff",
  "--colour-accent-soft": "var(--colour-mint)",
  "--colour-mark-ink": "var(--colour-espresso)",
  "--shadow-1": "none",
  "--shadow-dialog": "0 12px 40px rgb(52 35 19 / 0.25)",
  "--colour-backdrop": "rgb(52 35 19 / 0.45)",
};

/** The shapes: buttons a rounded rectangle, cards rounder, the big panels rounder still. */
const SHAPES: Readonly<Record<string, string>> = {
  "--radius-button": "0.75rem",
  "--radius-3": "1rem",
  "--radius-panel": "1.5rem",
};

describe("the restyle's tokens", () => {
  it.each(Object.entries(UNTOUCHED))("leaves %s at %s", (name, value) => {
    expect(tokens.get(name)).toBe(value);
  });

  it.each(Object.entries(NAMED))("names %s as %s", (name, value) => {
    expect(tokens.get(name)).toBe(value);
  });

  it.each(Object.entries(REPOINTED))("points %s at %s", (name, value) => {
    expect(tokens.get(name)).toBe(value);
  });

  it.each(Object.entries(SHAPES))("rounds %s to %s", (name, value) => {
    expect(tokens.get(name)).toBe(value);
  });
});

describe("the owner's tokens, merged into the one set", () => {
  const owner = properties("app/(owner)/owner.module.css");

  it("keeps only the owner's own warning, error and focus colours, at their values", () => {
    const colours = [...owner].filter(([, value]) => /#[0-9a-f]{3,8}\b/.test(value));
    expect(Object.fromEntries(colours)).toEqual({
      "--owner-warn": "#8a4b00",
      "--owner-warn-wash": "#fdf1e1",
      "--owner-error": "#a1261b",
      "--owner-error-wash": "#fbe9e7",
      "--owner-focus": "#1f5fbf",
    });
  });

  it("keeps no paper, ink, rule, field, accent, held, radius, spacing or target of its own", () => {
    const css = readFileSync("app/(owner)/owner.module.css", "utf8");
    for (const gone of [
      "paper",
      "card",
      "ink",
      "ink-soft",
      "rule",
      "field",
      "accent",
      "accent-ink",
      "held",
      "held-wash",
      "radius",
      "space-1",
      "space-2",
      "space-3",
      "space-4",
      "space-5",
      "space-6",
      "target",
    ]) {
      expect(css, `--owner-${gone} is still declared`).not.toMatch(new RegExp(`--owner-${gone}:`));
    }
  });
});
