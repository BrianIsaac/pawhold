import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Animal,
  CatAsleep,
  CatSitting,
  Disc,
  DogAsleep,
  DogSitting,
  PawPrint,
  PhonePaw,
  Stethoscope,
} from "../../app/components/Drawing";
import { EmptyState } from "../../app/components/EmptyState";
import { SPECIES } from "@/practice/species";

/*
 * The drawings (U18): each an image with its words, coloured only by class
 * from the tokens (no colour written on a shape), and the animal drawn by
 * its species.
 */

/** Every drawing as it renders with its own words. */
const DRAWINGS = [
  ["the dog sitting", <DogSitting key="dog" />, "A line drawing of a dog, sitting"],
  ["the cat sitting", <CatSitting key="cat" />, "A line drawing of a cat, sitting"],
  ["the paw print", <PawPrint key="paw" />, "A line drawing of a paw print"],
  ["the cat asleep", <CatAsleep key="cat-asleep" />, "A line drawing of a cat, asleep"],
  ["the dog asleep", <DogAsleep key="dog-asleep" />, "A line drawing of a dog, asleep"],
  ["the stethoscope", <Stethoscope key="stethoscope" />, "A line drawing of a stethoscope"],
  [
    "the phone",
    <PhonePaw key="phone" />,
    "A line drawing of a phone with a paw print on its screen",
  ],
] as const;

describe("the drawings", () => {
  it.each(DRAWINGS)("%s is an image named for a screen reader", (_name, drawing, words) => {
    const html = renderToStaticMarkup(drawing);

    expect(html).toMatch(/^<svg [^>]*role="img"/);
    expect(html).toContain(`aria-label="${words}"`);
  });

  it.each(DRAWINGS)("%s takes its colours from its classes alone", (_name, drawing) => {
    const html = renderToStaticMarkup(drawing);

    expect(html).not.toMatch(/\b(fill|stroke|color)="(?!none")/);
    expect(html).not.toMatch(/style="/);
  });

  it("takes the words it is given and a class for placing it", () => {
    const html = renderToStaticMarkup(<DogSitting label="A line drawing of Otis" className="x" />);

    expect(html).toContain('aria-label="A line drawing of Otis"');
    expect(html).toMatch(/^<svg class="[^"]+ x"/);
  });

  it("draws an animal's eyes closed in a smile when it is content", () => {
    const open = renderToStaticMarkup(<DogSitting />);
    const happy = renderToStaticMarkup(<DogSitting eyes="happy" />);

    expect(open).toContain('cx="79.5"');
    expect(happy).not.toContain('cx="79.5"');
    expect(happy).toContain('d="M75.5 30.5 q4 -3.6 8 0"');
    expect(renderToStaticMarkup(<CatSitting eyes="happy" />)).not.toContain('cx="52.5"');
  });
});

describe("an animal by its species", () => {
  it("draws a dog, a cat, or a paw print for another animal", () => {
    expect(renderToStaticMarkup(<Animal species="dog" />)).toBe(
      renderToStaticMarkup(<DogSitting />),
    );
    expect(renderToStaticMarkup(<Animal species="cat" eyes="happy" />)).toBe(
      renderToStaticMarkup(<CatSitting eyes="happy" />),
    );
    expect(renderToStaticMarkup(<Animal species="other" />)).toBe(
      renderToStaticMarkup(<PawPrint />),
    );
  });

  it.each(SPECIES)("draws %s with the words it is given", (species) => {
    expect(renderToStaticMarkup(<Animal species={species} label="Named" />)).toContain(
      'aria-label="Named"',
    );
  });
});

describe("a disc and an empty state", () => {
  it("sets a drawing on a disc of its size", () => {
    const html = renderToStaticMarkup(
      <Disc size="medium">
        <Stethoscope />
      </Disc>,
    );

    expect(html).toMatch(/^<div class="[^"]+" data-size="medium"><svg /);
  });

  it("puts the drawing on a large disc above the words", () => {
    const html = renderToStaticMarkup(
      <EmptyState figure={<CatAsleep />}>No cases yet.</EmptyState>,
    );

    expect(html).toMatch(
      /data-size="large"><svg [\s\S]*<\/svg><\/div><p [^>]*>No cases yet\.<\/p>/,
    );
  });
});
