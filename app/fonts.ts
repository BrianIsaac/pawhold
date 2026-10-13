import { Fraunces } from "next/font/google";

/**
 * Fraunces, the one web font: for the headings a person is spoken to in (the
 * landing page's, the owner's) and nowhere else, so every figure stays in
 * the system stack and keeps its tabular digits. Next fetches it from Google
 * Fonts at build time and serves it from pawhold's own origin; a visitor's
 * browser never asks Google for it. Its class sets `--font-display` on the
 * two layouts that use it, the landing page's and the owner's, so it is
 * preloaded on their routes and never on the practice's working screens;
 * elsewhere `--font-display` is undefined. The variable font's softness,
 * wonk and weight are set by the tokens beside `--font-sans`.
 */
export const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  display: "swap",
  variable: "--font-display",
});
