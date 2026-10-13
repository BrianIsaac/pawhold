import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { patientCase } from "@/db/schema";
import type { Species } from "@/practice/species";

import { expectNoSeriousViolations } from "../support/checks";
import { expectFraunces } from "../support/type";
import {
  brambleUpdate,
  openBrowserDatabase,
  refundedBramble,
  sentBrambleEstimate,
} from "./support/cases";
import { saveShot } from "./support/shots";

/*
 * The owner's head panel (U18, the restyle's
 * mock-ups): the animal drawn by its species on a mint panel at the panel's
 * radius, its name and species set large in Fraunces.
 */

const database = openBrowserDatabase();

test.afterAll(async () => {
  await database.close();
});

/** Mint and saddle as the browser reports them. */
const MINT = "rgb(187, 225, 195)";
const SADDLE = "rgb(139, 93, 51)";

/**
 * Holds the head panel as drawn: mint at 24 px, the animal's drawing named,
 * the name and species set large in Fraunces in saddle.
 *
 * @param page - The owner's page.
 * @param words - The name and species shown ("Bramble, dog").
 * @param drawn - What the drawing says to a screen reader.
 */
async function expectHeadPanel(page: Page, words: string, drawn: string): Promise<void> {
  const head = page.locator("header").first();
  await expect(head).toHaveCSS("background-color", MINT);
  await expect(head).toHaveCSS("border-radius", "24px");
  await expect(head.getByRole("img", { name: drawn, exact: true })).toBeVisible();
  const name = head.getByText(words, { exact: true });
  await expect(name).toBeVisible();
  await expect(name).toHaveCSS("color", SADDLE);
  await expectFraunces(name);
  // Saddle on mint is 3.9:1: large text only (24 px and over).
  const size = await name.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(size).toBeGreaterThanOrEqual(24);
  await expectFraunces(head.getByRole("heading", { level: 1 }));
  await expect(head.getByRole("heading", { level: 1 })).toHaveCSS("font-size", "24px");
}

/**
 * Gives a case another species, as "New case" would have recorded it.
 *
 * @param caseId - The case.
 * @param species - Its species.
 */
async function recordSpecies(caseId: string, species: Species): Promise<void> {
  await database.db.update(patientCase).set({ species }).where(eq(patientCase.id, caseId));
}

/**
 * Fails when the page runs wider than its window.
 *
 * @param page - The page.
 */
async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
}

test.describe("the owner's head panel", () => {
  test("a dog's estimate: Bramble drawn sitting, the name and species set large on mint", async ({
    page,
  }) => {
    const sent = await sentBrambleEstimate(database.db);
    await page.goto(sent.path);

    await expectHeadPanel(page, "Bramble, dog", "A line drawing of Bramble, a dog, sitting");
    await expectNoSeriousViolations(page, ["iframe"]);
    await expectNoOverflow(page);
  });

  test("a cat's estimate draws a cat", async ({ page }) => {
    const sent = await sentBrambleEstimate(database.db);
    await recordSpecies(sent.caseId, "cat");
    await page.goto(sent.path);

    await expectHeadPanel(page, "Bramble, cat", "A line drawing of Bramble, a cat, sitting");
    await expectNoSeriousViolations(page, ["iframe"]);
    await expectNoOverflow(page);
    await saveShot(page, "estimate-cat");
  });

  test("another animal's estimate draws a paw print", async ({ page }) => {
    const sent = await sentBrambleEstimate(database.db);
    await recordSpecies(sent.caseId, "other");
    await page.goto(sent.path);

    await expectHeadPanel(
      page,
      "Bramble, another animal",
      "A line drawing of a paw print, for Bramble, another animal",
    );
    await expectNoSeriousViolations(page, ["iframe"]);
    await expectNoOverflow(page);
    await saveShot(page, "estimate-other");
  });

  test("an update's head draws the animal above the practice's name", async ({ page }) => {
    const { update } = await brambleUpdate(database.db);
    await page.goto(update.path);

    await expectHeadPanel(page, "Bramble, dog", "A line drawing of Bramble, a dog, sitting");
    await expect(page.locator("header").first()).toContainText("Hollins Lane Veterinary Surgery");
    await expectNoSeriousViolations(page, ["iframe"]);
    await expectNoOverflow(page);
  });

  test("the receipt's head draws the animal", async ({ page }) => {
    const { first } = await refundedBramble(database.db);
    await page.goto(first.path);

    await expectHeadPanel(page, "Bramble, dog", "A line drawing of Bramble, a dog, sitting");
    await expectNoSeriousViolations(page);
    await expectNoOverflow(page);
  });
});
