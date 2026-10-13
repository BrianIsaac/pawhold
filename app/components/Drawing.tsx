import type { ReactNode } from "react";

import type { Species } from "@/practice/species";

import styles from "./Drawing.module.css";

/*
 * pawhold's drawings (the restyle's mock-ups, 13 October 2026): one line
 * style, saddle line on the ground the drawing sits on, his moss for the
 * patches. A shape in front is filled with that ground (`--drawing-ground`,
 * white unless a panel, a band or a disc says otherwise), so it hides the
 * one behind it. Every drawing names what it shows for a screen reader.
 */

/** Eyes open, or closed in a smile (the "Held" moment). */
export type Eyes = "open" | "happy";

/** What every drawing takes. */
export interface DrawingProps {
  /** What the drawing shows, for a screen reader. */
  readonly label?: string | undefined;
  /** A class for placing it. */
  readonly className?: string | undefined;
}

/** What an animal's drawing takes besides. */
export interface AnimalDrawingProps extends DrawingProps {
  readonly eyes?: Eyes | undefined;
}

/**
 * Wraps a drawing's shapes in an SVG with its words.
 *
 * @param props - The drawing.
 * @param props.viewBox - The drawing's box.
 * @param props.label - What it shows.
 * @param props.className - A class for placing it.
 * @param props.children - Its shapes.
 * @returns The SVG.
 */
function Drawing({
  viewBox,
  label,
  className,
  children,
}: {
  readonly viewBox: string;
  readonly label: string;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <svg
      className={className ? `${styles.drawing} ${className}` : styles.drawing}
      viewBox={viewBox}
      role="img"
      aria-label={label}
    >
      <g className={styles.line}>{children}</g>
    </svg>
  );
}

/**
 * A dog sitting, three-quarters to the right, a floppy ear and a collar.
 *
 * @param props - Its words, its eyes and its class.
 * @returns The drawing.
 */
export function DogSitting({
  label = "A line drawing of a dog, sitting",
  eyes = "open",
  className,
}: AnimalDrawingProps) {
  return (
    <Drawing viewBox="0 0 120 120" label={label} className={className}>
      <path d="M22 84 C14 80 12 70 17 62" />
      <path
        className={styles.fill}
        d="M61 44 C46 51 35 66 34 86 C33 101 40 110 52 110 L84 110 L83 95 C85 80 85 64 82 50 Z"
      />
      <path d="M36 92 C28 94 22 90 22 84" />
      <path
        className={styles.fill}
        d="M45 110 C41 98 47 85 59 84 C68 84 72 92 69.5 104 L68.5 110"
      />
      <path d="M48 110 L66 110" />
      <path d="M75 110 L85 110 M76 110 L76.5 82" />
      <path
        className={styles.fill}
        d="M58 27 C58 17 66 11 75 11 C85 11 91 18 91 27 C91 29 90.5 31 90 33 L99 36 C104 38 105 44 101 47 C97 50 91 50 87 49 C83 52 77 54 71 53 C63 51 58 43 58 34 Z"
      />
      <ellipse className={styles.dot} cx="101.5" cy="40" rx="3" ry="2.4" />
      {eyes === "open" ? (
        <circle className={styles.dot} cx="79.5" cy="29.5" r="2.2" />
      ) : (
        <path d="M75.5 30.5 q4 -3.6 8 0" />
      )}
      <path d="M89 46.5 q-3.5 3 -8 1.2" />
      <path
        className={styles.patch}
        d="M63 17 C54 17 49 26 49 37 C49 46 53 52 58 50 C63 48 65 39 65 29 C65 23 64.5 19 63 17 Z"
      />
      <path
        className={styles.patch}
        d="M62 50.5 C68 56 76 58 83 54.5 L84 59.5 C77 63 68 61.5 61.5 56 Z"
        strokeWidth="2"
      />
    </Drawing>
  );
}

/**
 * A cat sitting, facing us, its tail round its side.
 *
 * @param props - Its words, its eyes and its class.
 * @returns The drawing.
 */
export function CatSitting({
  label = "A line drawing of a cat, sitting",
  eyes = "open",
  className,
}: AnimalDrawingProps) {
  return (
    <Drawing viewBox="0 0 120 120" label={label} className={className}>
      <path d="M80 104 C95 106 101 95 96 84 C93 78 95 72 100 70" />
      <path
        className={styles.fill}
        d="M49 52 C40 63 36 82 38 98 C39 106 44 110 52 110 L68 110 C76 110 81 106 82 98 C84 82 80 63 71 52 Z"
      />
      <path d="M54 84 L54 110 M66 84 L66 110" />
      <path d="M50 110 q4 -4 8 0 M62 110 q4 -4 8 0" />
      <path
        className={styles.fill}
        d="M42 40 C42 31 43.5 23 46 14 L55 23.5 C58.5 22.5 61.5 22.5 65 23.5 L74 14 C76.5 23 78 31 78 40 C78 50 70 57 60 57 C50 57 42 50 42 40 Z"
      />
      <path
        className={styles.patch}
        d="M47.5 21 L52.5 26 L48 29 Z M72.5 21 L67.5 26 L72 29 Z"
        strokeWidth="1.5"
      />
      {eyes === "open" ? (
        <>
          <circle className={styles.dot} cx="52.5" cy="38" r="2.2" />
          <circle className={styles.dot} cx="67.5" cy="38" r="2.2" />
        </>
      ) : (
        <path d="M49.5 39 q3 -3 6 0 M64.5 39 q3 -3 6 0" />
      )}
      <path className={styles.solid} d="M58 44 L62 44 L60 46.5 Z" strokeWidth="1.5" />
      <path d="M60 46.5 q-2.5 3 -5 1 M60 46.5 q2.5 3 5 1" />
      <path d="M51 45 L38 43 M51 48 L39 50 M69 45 L82 43 M69 48 L81 50" strokeWidth="1.5" />
    </Drawing>
  );
}

/**
 * A paw print: the animal that is neither a dog nor a cat, drawn in the same
 * line as the two and from the icon's own paw.
 *
 * @param props - Its words and its class.
 * @returns The drawing.
 */
export function PawPrint({ label = "A line drawing of a paw print", className }: DrawingProps) {
  return (
    <Drawing viewBox="0 0 120 120" label={label} className={className}>
      <path
        className={styles.patch}
        d="M60 60 C47 60 35 73 34 86 C33 97 41 104 51 101 C55 100 57 98 60 98 C63 98 65 100 69 101 C79 104 87 97 86 86 C85 73 73 60 60 60 Z"
      />

      <ellipse
        className={styles.fill}
        cx="29"
        cy="57"
        rx="8.5"
        ry="11"
        transform="rotate(-24 29 57)"
      />
      <ellipse
        className={styles.fill}
        cx="47"
        cy="34"
        rx="9"
        ry="12"
        transform="rotate(-8 47 34)"
      />
      <ellipse className={styles.fill} cx="73" cy="34" rx="9" ry="12" transform="rotate(8 73 34)" />
      <ellipse
        className={styles.fill}
        cx="91"
        cy="57"
        rx="8.5"
        ry="11"
        transform="rotate(24 91 57)"
      />
    </Drawing>
  );
}

/**
 * A cat asleep, curled up, tail over its nose.
 *
 * @param props - Its words and its class.
 * @returns The drawing.
 */
export function CatAsleep({ label = "A line drawing of a cat, asleep", className }: DrawingProps) {
  return (
    <Drawing viewBox="0 0 140 96" label={label} className={className}>
      <path
        className={styles.fill}
        d="M22 76 C20 52 46 36 76 37 C104 38 122 52 120 70 C119 80 110 86 98 86 L36 86 C28 86 22 82 22 76 Z"
      />
      <path d="M70 60 C80 52 96 52 104 60" />
      <path
        className={styles.fill}
        d="M24 70 C22 58 30 50 41 50 L44 41 L50 51 C56 54 59 61 57 69 C55 78 47 84 37 84 C30 84 25 79 24 70 Z"
      />
      <path className={styles.fill} d="M27 56 L25 45 L35 51" />
      <path className={styles.patch} d="M27.5 51 L26.8 47.5 L30.5 49.8 Z" strokeWidth="1.2" />
      <path d="M31 66 q3.5 2.5 7 0 M43 66 q3.5 2.5 7 0" />
      <path className={styles.solid} d="M38.5 72 L41.5 72 L40 74 Z" strokeWidth="1.2" />
      <path
        className={styles.patch}
        d="M120 72 C124 86 104 92 74 90 C62 89 54 86 50 82 C56 83 66 84 76 84 C100 84 114 82 120 72 Z"
      />
      <path d="M78 16 h9 l-9 10 h9 M94 6 h6 l-6 7 h6" strokeWidth="2" />
    </Drawing>
  );
}

/**
 * A dog asleep, lying down, its head on its paws.
 *
 * @param props - Its words and its class.
 * @returns The drawing.
 */
export function DogAsleep({ label = "A line drawing of a dog, asleep", className }: DrawingProps) {
  return (
    <Drawing viewBox="0 0 140 96" label={label} className={className}>
      <path d="M118 70 C128 66 132 58 129 50" />
      <path
        className={styles.fill}
        d="M34 82 C32 60 52 47 78 47 C104 47 122 58 121 74 C121 81 116 86 108 86 L40 86 C36 86 34 85 34 82 Z"
      />
      <path d="M86 86 C84 76 90 68 100 68 C108 68 112 76 110 86" />
      <path
        className={styles.fill}
        d="M16 74 C13 61 22 51 35 51 C46 51 53 59 53 68 L53 76 C53 82 48 86 42 86 L14 86 C9 86 7 81 9 78 C11 75.5 13 75 16 74 Z"
      />
      <ellipse className={styles.dot} cx="10.5" cy="79.5" rx="3" ry="2.4" />
      <path d="M24 66 q3.5 2.5 7 0" />
      <path
        className={styles.patch}
        d="M33 53 C44 51 49 60 47 72 C46 77 39 77 38 70 C37 63 36 58 33 53 Z"
      />
      <path d="M52 86 L28 86" />
      <path d="M70 22 h9 l-9 10 h9 M86 12 h6 l-6 7 h6" strokeWidth="2" />
    </Drawing>
  );
}

/**
 * A stethoscope: the practice's door on the landing page.
 *
 * @param props - Its words and its class.
 * @returns The drawing.
 */
export function Stethoscope({
  label = "A line drawing of a stethoscope",
  className,
}: DrawingProps) {
  return (
    <Drawing viewBox="0 0 80 80" label={label} className={className}>
      <path d="M24 12 L24 30 C24 43 32 50 40 50 C48 50 56 43 56 30 L56 12" />
      <circle className={styles.solid} cx="24" cy="10" r="2.5" />
      <circle className={styles.solid} cx="56" cy="10" r="2.5" />
      <path d="M40 50 L40 58 C40 68 47 72 54 71 C61 70 64 64 64 58" />
      <circle className={styles.patch} cx="64" cy="51" r="7.5" />
      <circle className={styles.dot} cx="64" cy="51" r="2.5" />
    </Drawing>
  );
}

/**
 * A phone with a paw print on its screen: the owner's door on the landing page.
 *
 * @param props - Its words and its class.
 * @returns The drawing.
 */
export function PhonePaw({
  label = "A line drawing of a phone with a paw print on its screen",
  className,
}: DrawingProps) {
  return (
    <Drawing viewBox="0 0 80 80" label={label} className={className}>
      <rect className={styles.fill} x="22" y="7" width="36" height="66" rx="7" />
      <path d="M35 13 L45 13" />
      <path d="M36 66 L44 66" />
      <g className={styles.patch} strokeWidth="1.8">
        <ellipse cx="40" cy="45" rx="7.5" ry="6.5" />
        <circle cx="30.5" cy="35.5" r="3.2" />
        <circle cx="35.5" cy="29.5" r="3.2" />
        <circle cx="44.5" cy="29.5" r="3.2" />
        <circle cx="49.5" cy="35.5" r="3.2" />
      </g>
    </Drawing>
  );
}

/** Each species' drawing: a dog, a cat, and a paw print for any other animal. */
const ANIMALS: Readonly<Record<Species, (props: AnimalDrawingProps) => ReactNode>> = {
  dog: DogSitting,
  cat: CatSitting,
  other: PawPrint,
};

/**
 * An animal's drawing by its species, sitting (U17's species keys it).
 *
 * @param props - The species, its words, its eyes and its class.
 * @param props.species - The animal's species.
 * @returns The drawing.
 */
export function Animal({ species, ...props }: AnimalDrawingProps & { readonly species: Species }) {
  const Drawn = ANIMALS[species];
  return <Drawn {...props} />;
}

/** How large a disc is: beside the hold, on a landing door, above an empty state. */
export type DiscSize = "small" | "medium" | "large";

/**
 * A drawing on a disc of mint, its shapes filled with the mint.
 *
 * @param props - The disc's size and its drawing.
 * @param props.size - How large it is.
 * @param props.children - The drawing.
 * @returns The disc.
 */
export function Disc({
  size,
  children,
}: {
  readonly size: DiscSize;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.disc} data-size={size}>
      {children}
    </div>
  );
}
