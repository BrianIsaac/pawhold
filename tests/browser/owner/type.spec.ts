import { expect, test } from "@playwright/test";

import { expectFraunces, expectSystemStack } from "../support/type";
import { openBrowserDatabase, sentBrambleEstimate } from "./support/cases";

/*
 * The restyle on the owner's page (U16): its headings in Fraunces, every
 * figure in the system stack so the money keeps its tabular digits, and the
 * owner's focus ring as it was.
 */

const database = openBrowserDatabase();

test.afterAll(async () => {
  await database.close();
});

test("the owner's headings are in Fraunces and every figure in the system stack", async ({
  page,
}) => {
  const sent = await sentBrambleEstimate(database.db);
  await page.goto(sent.path);

  await expectFraunces(page.getByRole("heading", { level: 1 }));
  await expectFraunces(page.getByRole("heading", { level: 2, name: "What the estimate covers" }));

  await expectSystemStack(page.getByText("Likely £731.00 to £927.00", { exact: false }));
  const line = page
    .getByRole("list", { name: "What the estimate covers" })
    .getByRole("listitem")
    .filter({ hasText: "A blood test before the anaesthetic" });
  await expectSystemStack(line.getByText("£72.00"));
  await expect(line.getByText("£72.00")).toHaveCSS("font-variant-numeric", "tabular-nums");
});

test("the owner's focus ring is the blue it was", async ({ page }) => {
  const sent = await sentBrambleEstimate(database.db);
  await page.goto(sent.path);

  const notes = page.getByText("What the vet wrote").first();
  await notes.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");

  await expect(notes).toBeFocused();
  await expect(notes).toHaveCSS("outline-color", "rgb(31, 95, 191)");
});
