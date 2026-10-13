/*
 * A case's species (U17), with no import: the schema's enum is made from this
 * list, and the "New case" dialog reads it in the browser.
 */

/** The species a case may record, in the order "New case" offers them: the one list. */
export const SPECIES = ["dog", "cat", "other"] as const;

/** A case's species. */
export type Species = (typeof SPECIES)[number];

/** Each species as a field offers it. */
const LABELS: Readonly<Record<Species, string>> = {
  dog: "Dog",
  cat: "Cat",
  other: "Other",
};

/** Each species after an animal's name. */
const WORDS: Readonly<Record<Species, string>> = {
  dog: "dog",
  cat: "cat",
  other: "another animal",
};

/** What "New case" asks when no species is chosen, and says when none was. */
export const CHOOSE_SPECIES = "Choose the species";

/** The species as the "New case" field's options. */
export const SPECIES_OPTIONS: readonly { value: Species; label: string }[] = SPECIES.map(
  (value) => ({ value, label: LABELS[value] }),
);

/**
 * A species as a field's value reads.
 *
 * @param species - The species.
 * @returns Its label, such as "Dog".
 */
export function speciesLabel(species: Species): string {
  return LABELS[species];
}

/**
 * An animal named with its species, as the pages that name it put it.
 *
 * @param name - The animal's name.
 * @param species - Its species.
 * @returns The two, such as "Otis, dog".
 */
export function withSpecies(name: string, species: Species): string {
  return `${name}, ${WORDS[species]}`;
}
