import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { WALK_FINDING, WALK_PHOTO_PATH } from "../support/update-walk-words";
import {
  expect,
  openNewCase,
  PLAN_NOTES,
  signInAsPractice,
  test,
  WIDTHS,
  type Width,
} from "./fixtures";
import { openBrowserDatabase } from "./owner/support/cases";
import {
  deliverDischargeWebhooks,
  dischargedCase,
  DOUBLE_URL,
  twoHoldCase,
} from "./support/discharge";

/** The smallest a tap target may be, each way (plan 5, U5's acceptance). */
const TARGET_PX = 44;

/** A target found smaller than {@link TARGET_PX}. */
interface SmallTarget {
  readonly element: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Every visible interactive element smaller than 44 px either way. A
 * checkbox or radio inside its label is measured by the label, which is its
 * target; anything inside a closed disclosure or dialog is not on the screen.
 *
 * @param page - The page.
 * @returns The targets too small.
 */
async function smallTargets(page: Page): Promise<SmallTarget[]> {
  return page.evaluate((min) => {
    const selector = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      "[tabindex]:not([tabindex='-1'])",
      "[role=button]",
      "[role=link]",
    ].join(",");
    const small: { element: string; width: number; height: number }[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(element);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        element.getClientRects().length === 0
      ) {
        continue;
      }
      const target =
        element instanceof HTMLInputElement &&
        (element.type === "checkbox" || element.type === "radio") &&
        element.closest("label")
          ? element.closest("label")!
          : element;
      const box = target.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) {
        continue;
      }
      if (box.width < min - 0.5 || box.height < min - 0.5) {
        small.push({
          element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""} "${(element.textContent ?? element.getAttribute("aria-label") ?? "").trim().slice(0, 40)}"`,
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
      }
    }
    return small;
  }, TARGET_PX);
}

/**
 * Checks the page as it stands: no serious or critical axe violation, and
 * every target at least 44 px.
 *
 * @param page - The page.
 * @returns Resolves once checked.
 */
async function checkScreen(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
  expect(serious).toEqual([]);
  expect(await smallTargets(page)).toEqual([]);
}

/**
 * Runs a screen's steps on a database handle of its own, closed after.
 *
 * @param steps - The steps, given the run's database.
 * @returns Resolves once they ran.
 */
async function withDatabase(
  steps: (db: ReturnType<typeof openBrowserDatabase>["db"]) => Promise<void>,
): Promise<void> {
  const database = openBrowserDatabase();
  try {
    await steps(database.db);
  } finally {
    await database.close();
  }
}

/** Each screen, brought to the state it is checked in. */
const SCREENS: Record<string, (page: Page) => Promise<void>> = {
  "the landing page": async (page) => {
    await page.goto("/");
  },
  "the practice's door, its first screen": async (page) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Try it as the practice" }).click();
    await expect(page.getByRole("link", { name: "Bramble" })).toBeVisible();
  },
  "the owner's door, its first screen with the sandbox login": async (page) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Try it as the owner" }).click();
    await expect(
      page.getByRole("complementary", { name: "Testing in PayPal's sandbox" }),
    ).toBeVisible();
  },
  "today's cases, signed out": async (page) => {
    await page.goto("/today");
    await expect(page.getByRole("button", { name: "Try it as the practice" })).toBeVisible();
  },
  "today's cases": async (page) => {
    await signInAsPractice(page);
    await page.goto("/today");
    await expect(page.getByRole("link", { name: "Bramble" })).toBeVisible();
  },
  "today's new case dialog, a field at fault": async (page) => {
    await signInAsPractice(page);
    await page.goto("/today");
    await page.getByRole("button", { name: "New case" }).click();
    await page.getByRole("button", { name: "Open the case" }).click();
    // The dialog's own alert: Next's route announcer is an alert too, once it mounts.
    await expect(
      page.getByRole("dialog", { name: "Open a case" }).getByRole("alert"),
    ).toBeVisible();
  },
  "a new case": async (page) => {
    await signInAsPractice(page);
    await openNewCase(page, { patient: "Pepper", owner: "Sam Patel", procedure: "Dental" });
  },
  "a draft, a line open for change, the review open": async (page) => {
    await signInAsPractice(page);
    await openNewCase(page, { patient: "Pepper", owner: "Sam Patel", procedure: "Dental" });
    await page.getByRole("textbox", { name: "Clinical notes" }).fill(PLAN_NOTES);
    await page.getByRole("button", { name: "Draft estimate" }).click();
    await page.getByText("Change line 3").click();
    await expect(page.getByRole("button", { name: "Save line 3" })).toBeVisible();
    await checkScreen(page);
    await page.getByRole("button", { name: "Send to Sam" }).click();
    await expect(page.getByRole("dialog", { name: "Send this estimate to Sam?" })).toBeVisible();
  },
  "an estimate sent": async (page) => {
    await signInAsPractice(page);
    await openNewCase(page, { patient: "Pepper", owner: "Sam Patel", procedure: "Dental" });
    await page.getByRole("textbox", { name: "Clinical notes" }).fill(PLAN_NOTES);
    await page.getByRole("button", { name: "Draft estimate" }).click();
    await page.getByRole("button", { name: "Send to Sam" }).click();
    await page
      .getByRole("dialog", { name: "Send this estimate to Sam?" })
      .getByRole("button", { name: "Send to Sam" })
      .click();
    await expect(page.getByRole("status")).toBeVisible();
  },
  "the seeded case, its timeline's details open": async (page) => {
    await signInAsPractice(page);
    await page.goto("/today");
    await page.getByRole("link", { name: "Bramble" }).click();
    await page.getByText("Show PayPal and model details").nth(5).click();
  },
  "an update drafted with its photo": async (page) => {
    await signInAsPractice(page);
    await page.goto("/today");
    await page.getByRole("link", { name: "Bramble" }).click();
    const form = page.getByRole("region", { name: "Add an update" });
    await form.getByLabel("What did you find, and what do you recommend?").fill(WALK_FINDING);
    await form.getByLabel("Add a photo").setInputFiles(WALK_PHOTO_PATH);
    await form.getByLabel("Show the photo to the owner").check();
    await form.getByRole("button", { name: "Draft the update" }).click();
    await expect(page.getByRole("region", { name: "Update, version 3" })).toBeVisible();
    await checkScreen(page);
    await page.getByRole("button", { name: "Ask Nadia to approve £130.00" }).click();
    await expect(
      page.getByRole("dialog", { name: "Ask Nadia to approve the update?" }),
    ).toBeVisible();
  },
  "the seeded case's bill, a line above its approval and work off the estimate": async (page) => {
    await signInAsPractice(page);
    await page.goto("/today");
    await page.getByRole("link", { name: "Bramble" }).click();
    await page.getByRole("link", { name: "Discharge" }).click();
    await page.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }).fill("3");
    const extra = page.getByRole("region", { name: "Work not on an approved estimate" });
    await extra.getByLabel("Item").selectOption({ index: 1 });
    await extra.getByRole("button", { name: "Note the work" }).click();
    await expect(extra.getByText(/not charged$/)).toBeVisible();
  },
  "a two-hold bill with its allocation, the confirm dialog open": async (page) => {
    test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
    const practiceId = await signInAsPractice(page);
    await withDatabase(async (db) => {
      const kase = await twoHoldCase(db, practiceId);
      await page.goto(`/cases/${kase.caseId}/discharge`);
    });
    await expect(page.locator("#bill-verdict").getByText(/will be captured/)).toBeVisible();
    await checkScreen(page);
    await page.getByRole("button", { name: /^Confirm and charge/ }).click();
    await expect(page.getByRole("dialog", { name: "Confirm the bill?" })).toBeVisible();
  },
  "a discharge landed and confirmed by PayPal": async (page) => {
    test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
    const practiceId = await signInAsPractice(page);
    await withDatabase(async (db) => {
      const kase = await dischargedCase(db, practiceId);
      await deliverDischargeWebhooks(db, kase.caseId);
      await page.goto(`/cases/${kase.caseId}/discharge`);
    });
    await expect(page.getByText(/^Confirmed by PayPal/)).toHaveCount(3);
  },
  "a discharged case, the refund dialog with its faults": async (page) => {
    test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
    const practiceId = await signInAsPractice(page);
    await withDatabase(async (db) => {
      const kase = await dischargedCase(db, practiceId);
      await page.goto(`/cases/${kase.caseId}`);
    });
    await checkScreen(page);
    await page
      .getByRole("region", { name: "Refund" })
      .getByRole("button", { name: "Refund" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Refund Sam?" });
    await dialog.getByLabel("Amount").fill("2000");
    await dialog.getByRole("button", { name: "Refund" }).click();
    await expect(dialog.getByText("Say why: it is kept on the case's timeline.")).toBeVisible();
  },
  "an update sent": async (page) => {
    await signInAsPractice(page);
    await page.goto("/today");
    await page.getByRole("link", { name: "Bramble" }).click();
    const form = page.getByRole("region", { name: "Add an update" });
    await form.getByLabel("What did you find, and what do you recommend?").fill(WALK_FINDING);
    await form.getByLabel("Add a photo").setInputFiles(WALK_PHOTO_PATH);
    await form.getByRole("button", { name: "Draft the update" }).click();
    await page.getByRole("button", { name: "Ask Nadia to approve £130.00" }).click();
    await page
      .getByRole("dialog", { name: "Ask Nadia to approve the update?" })
      .getByRole("button", { name: "Ask Nadia to approve £130.00" })
      .click();
    await expect(page.getByRole("status")).toBeVisible();
  },
};

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`at ${WIDTHS[width].width} px`, () => {
    test.use({ width });
    for (const [screen, reach] of Object.entries(SCREENS)) {
      test(`axe finds no serious violation and every target is at least 44 px: ${screen}`, async ({
        page,
      }) => {
        await reach(page);
        await checkScreen(page);
      });
    }
  });
}
