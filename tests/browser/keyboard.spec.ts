import type { Locator, Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { patientCase } from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { ownerLink } from "@/owner/link";

import { WALK_FINDING, WALK_PHOTO_PATH } from "../support/update-walk-words";
import { expect, signInAsPractice, test, WIDTHS, type Width } from "./fixtures";
import { browserSecret, openBrowserDatabase } from "./owner/support/cases";
import {
  DAY_STATES,
  GRID_NAME,
  openHeldDay,
  prepareDay,
  shownAs,
  STATE_WORDS,
} from "./support/day";
import { DOUBLE_URL } from "./support/discharge";
import { approveAtTheDouble } from "./support/double-approval";

/*
 * Keyboard only (U11): today, a case, the update, the discharge's confirm,
 * the owner's answer and the day view, each walked with Tab, Shift+Tab,
 * Enter and Space alone, and every element the Tab key stops on shows a
 * focus ring a sighted keyboard user can see.
 */

/** How many Tab presses a walk allows before it calls an element unreachable. */
const MAX_TABS = 120;

/**
 * Whether the focused element draws a visible focus indicator: an outline at
 * least 2 px wide, or a box shadow.
 *
 * @param page - The page.
 * @returns What the focused element is and whether its ring shows.
 */
async function focusRing(page: Page): Promise<{ element: string; visible: boolean }> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) {
      return { element: "body", visible: true };
    }
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
    const shadow = style.boxShadow !== "none";
    return {
      element: `${element.tagName.toLowerCase()} "${(element.textContent ?? element.getAttribute("aria-label") ?? "").trim().slice(0, 40)}"`,
      visible: outline || shadow,
    };
  });
}

/**
 * Presses Tab until the target has focus, checking the focus ring on every
 * element passed on the way.
 *
 * @param page - The page.
 * @param target - The element to reach.
 */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < MAX_TABS; presses += 1) {
    await page.keyboard.press("Tab");
    const ring = await focusRing(page);
    expect(ring.visible, `no visible focus ring on ${ring.element}`).toBe(true);
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  throw new Error(`${await target.textContent()} was not reached in ${MAX_TABS} presses of Tab`);
}

/**
 * A seeded case's id in a practice.
 *
 * @param practiceId - The practice.
 * @param patient - The patient.
 * @returns The case's id.
 */
async function caseOf(practiceId: string, patient: string): Promise<string> {
  const database = openBrowserDatabase();
  try {
    const [found] = await database.db
      .select({ id: patientCase.id })
      .from(patientCase)
      .where(and(eq(patientCase.practiceId, practiceId), eq(patientCase.patientName, patient)));
    return found!.id;
  } finally {
    await database.close();
  }
}

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`keyboard only at ${WIDTHS[width].width} px`, () => {
    test.use({ width });

    test("from today's list into a case, the skip link first", async ({ page }) => {
      await signInAsPractice(page);
      await page.goto("/today");
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to the page" })).toBeFocused();
      await page.keyboard.press("Enter");
      await tabTo(page, page.getByRole("link", { name: "Bramble" }));
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1, name: "Bramble" })).toBeVisible();
    });

    test("a case's update: drafted, reviewed and sent", async ({ page }) => {
      const practiceId = await signInAsPractice(page);
      await page.goto(`/cases/${await caseOf(practiceId, "Bramble")}`);
      const form = page.getByRole("region", { name: "Add an update" });
      const finding = form.getByLabel("What did you find, and what do you recommend?");
      await tabTo(page, finding);
      await page.keyboard.type(WALK_FINDING);
      // A file is chosen in the system's own dialog, which a page cannot drive.
      await form.getByLabel("Add a photo").setInputFiles(WALK_PHOTO_PATH);
      await tabTo(page, form.getByLabel("Show the photo to the owner"));
      await page.keyboard.press("Space");
      await expect(form.getByLabel("Show the photo to the owner")).toBeChecked();
      await tabTo(page, form.getByRole("button", { name: "Draft the update" }));
      await page.keyboard.press("Enter");
      const send = page.getByRole("button", { name: "Ask Nadia to approve £130.00" });
      await expect(send).toBeVisible();
      await tabTo(page, send);
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Ask Nadia to approve the update?" });
      await expect(dialog).toBeVisible();
      await tabTo(page, dialog.getByRole("button", { name: "Ask Nadia to approve £130.00" }));
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status")).toContainText("Sent. Nadia can approve the update");
    });

    test("a dialog closes with Escape and gives focus back", async ({ page }) => {
      const practiceId = await signInAsPractice(page);
      await page.goto(`/cases/${await caseOf(practiceId, "Juno")}`);
      const withdraw = page.getByRole("button", { name: "Withdraw the update" });
      await tabTo(page, withdraw);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "Withdraw the update?" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(withdraw).toBeFocused();
    });

    test("the discharge's confirm, to the money captured", async ({ page }) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      await page.goto("/try/owner");
      await approveAtTheDouble(page);
      await page.goto("/today");
      await tabTo(page, page.getByRole("link", { name: "Otis" }));
      await page.keyboard.press("Enter");
      const discharge = page.getByRole("link", { name: "Discharge" });
      await expect(discharge).toBeVisible();
      await tabTo(page, discharge);
      await page.keyboard.press("Enter");
      const confirm = page.getByRole("button", { name: "Confirm and charge £876.00" });
      await expect(confirm).toBeVisible();
      await tabTo(page, confirm);
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Confirm the bill?" });
      await expect(dialog).toBeVisible();
      await tabTo(page, dialog.getByRole("button", { name: "Confirm and charge £876.00" }));
      await page.keyboard.press("Enter");
      await expect(page.getByText("£876.00 captured. £134.00 released to Priya.")).toBeVisible({
        timeout: 20_000,
      });
    });

    test("the owner's answer: what the vet wrote opened, and don't go ahead", async ({ page }) => {
      const practiceId = await signInAsPractice(page);
      const caseId = await caseOf(practiceId, "Juno");
      const database = openBrowserDatabase();
      let path: string;
      try {
        const sent = (await caseEstimateVersions(database.db, practiceId, caseId)).filter(
          (version) => version.sentAt !== null,
        );
        path = (
          await ownerLink(
            database.db,
            { practiceId, caseId, versionId: sent.at(-1)!.id },
            { secret: browserSecret(), now: new Date() },
          )
        ).path;
      } finally {
        await database.close();
      }
      await page.goto(path);
      const wrote = page.getByText("What the vet wrote").nth(1);
      await tabTo(page, wrote);
      await page.keyboard.press("Enter");
      await expect(page.locator("details[open]")).toHaveCount(1);
      await tabTo(page, page.getByRole("button", { name: "Don't go ahead" }));
      await page.keyboard.press("Enter");
      await expect(page.getByText(/^You said not to go ahead\./)).toBeVisible();
    });

    for (const state of DAY_STATES) {
      test(`the day, ${STATE_WORDS[state]}: the agent's hold undone, and a booking opened`, async ({
        page,
      }) => {
        await prepareDay(page, state);
        await openHeldDay(page, state);
        const held = page.getByRole("region", { name: "Held by pawhold" });
        await tabTo(page, held.getByRole("button", { name: /^Undo/ }));
        await page.keyboard.press("Enter");
        await expect(held).toHaveCount(0);
        await shownAs(page, state);
        const grid = page.getByRole("region", { name: GRID_NAME });
        await tabTo(page, grid);
        const before = await grid.evaluate((element) => element.scrollLeft);
        await page.keyboard.press("ArrowRight");
        await expect
          .poll(() => grid.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(before);
        const links = grid.getByRole("link");
        await tabTo(page, links.first());
        const last = links.last();
        await tabTo(page, last);
        const name = (await last.textContent()) ?? "";
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/\/cases\/[0-9a-f-]{36}$/);
        const patient = await page.getByRole("heading", { level: 1 }).textContent();
        expect(name).toContain(patient);
      });
    }
  });
}
