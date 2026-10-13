import { describe, expect, it } from "vitest";

import { animalSpecies } from "@/db/schema";
import { SPECIES, SPECIES_OPTIONS, speciesLabel, withSpecies } from "@/practice/species";

describe("a case's species (U17)", () => {
  it("is one of dog, cat and other, as the schema's enum lists them", () => {
    expect(SPECIES).toEqual(["dog", "cat", "other"]);
    expect(animalSpecies.enumValues).toEqual(SPECIES);
  });

  it("offers each species once, in the enum's order, with its label", () => {
    expect(SPECIES_OPTIONS).toEqual([
      { value: "dog", label: "Dog" },
      { value: "cat", label: "Cat" },
      { value: "other", label: "Other" },
    ]);
  });

  it("labels each species for a field's value", () => {
    expect(speciesLabel("dog")).toBe("Dog");
    expect(speciesLabel("cat")).toBe("Cat");
    expect(speciesLabel("other")).toBe("Other");
  });

  it("names an animal with its species, as a page's head does", () => {
    expect(withSpecies("Otis", "dog")).toBe("Otis, dog");
    expect(withSpecies("Poppy", "cat")).toBe("Poppy, cat");
    expect(withSpecies("Moss", "other")).toBe("Moss, another animal");
  });
});
