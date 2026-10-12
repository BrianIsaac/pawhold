import type { Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { DRAFT_FAILED } from "@/agent/wording";
import { patientCase } from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { ownerLink } from "@/owner/link";

import {
  expect,
  openNewCase,
  PLAN_NOTES,
  signInAsPractice,
  test,
  WIDTHS,
  type Width,
} from "./fixtures";
import { browserSecret, openBrowserDatabase } from "./owner/support/cases";

/*
 * The empty, loading and error states (U11): what a judge meets when there is
 * nothing to show, when an estimate or an update was withdrawn, when a draft
 * could not be made, when a page does not exist, and once an owner has
 * answered an update. Each at both widths.
 */

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

/**
 * The owner's link to a case's latest sent version.
 *
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The link's path.
 */
async function ownerPath(practiceId: string, caseId: string): Promise<string> {
  const database = openBrowserDatabase();
  try {
    const sent = (await caseEstimateVersions(database.db, practiceId, caseId)).filter(
      (version) => version.sentAt !== null,
    );
    const link = await ownerLink(
      database.db,
      { practiceId, caseId, versionId: sent.at(-1)!.id },
      { secret: browserSecret(), now: new Date() },
    );
    return link.path;
  } finally {
    await database.close();
  }
}

/**
 * Opens a seeded case's owner page in a new practice.
 *
 * @param page - The page.
 * @param patient - The patient.
 * @returns The practice and the case.
 */
async function ownerPageOf(
  page: Page,
  patient: string,
): Promise<{ practiceId: string; caseId: string }> {
  const practiceId = await signInAsPractice(page);
  const caseId = await caseOf(practiceId, patient);
  await page.goto(await ownerPath(practiceId, caseId));
  return { practiceId, caseId };
}

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`the empty and error states at ${WIDTHS[width].width} px`, () => {
    test.use({ width });

    test("a withdrawn estimate's link says it was withdrawn and that nothing was charged", async ({
      page,
    }) => {
      await ownerPageOf(page, "Milo");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "This estimate was withdrawn",
      );
      await expect(
        page.getByText(
          "Hollins Lane Veterinary Surgery withdrew this estimate, so there is nothing to authorise and nothing has been charged. Ask them if you'd like it sent again.",
        ),
      ).toBeVisible();
      await expect(page.getByText(/^Likely /)).toHaveCount(0);
    });

    test("a withdrawn update's link says it was withdrawn and that what was held stays", async ({
      page,
    }) => {
      const practiceId = await signInAsPractice(page);
      const caseId = await caseOf(practiceId, "Juno");
      await page.goto(`/cases/${caseId}`);
      await page.getByRole("button", { name: "Withdraw the update" }).click();
      await page
        .getByRole("dialog", { name: "Withdraw the update?" })
        .getByRole("button", { name: "Withdraw it" })
        .click();
      await expect(page.getByRole("status")).toBeVisible();
      await page.goto(await ownerPath(practiceId, caseId));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("This update was withdrawn");
      await expect(
        page.getByText(
          "Hollins Lane Veterinary Surgery withdrew this update, so there is nothing to approve. What you authorised before stays as it was.",
        ),
      ).toBeVisible();
    });

    test("an update's page lists what it adds and nothing it carried over, with the finding in full", async ({
      page,
    }) => {
      await ownerPageOf(page, "Juno");
      const added = page.getByRole("list", { name: "What this adds" }).getByRole("listitem");
      await expect(added).toHaveCount(2);
      await expect(added.first()).toContainText("Removing the second lump");
      await expect(added.last()).toContainText("Laboratory check of the second lump");
      await expect(page.getByText("This adds £345.00 to Juno's estimate.")).toBeVisible();
      await expect(
        page.getByText(
          "Rowan found a second lump, on Juno's right shoulder, at the check before the operation.",
          { exact: false },
        ),
      ).toBeVisible();
      await expect(
        page.getByText(/^Pre-op check found a second lump on the right shoulder/),
      ).toBeVisible();

      const practiceSide = await signInAsPractice(page);
      await page.goto(`/cases/${await caseOf(practiceSide, "Juno")}`);
      const sent = page.getByRole("list", { name: "Lines of version 2" });
      await expect(sent.getByRole("listitem")).toHaveCount(2);
    });

    test("after Sent, the practice can open the page the owner's link opens, as a judge has no phone", async ({
      page,
    }) => {
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
      await expect(
        page.getByText("There is no phone in the demo: this is the page Sam's link opens."),
      ).toBeVisible();
      const opened = page.waitForEvent("popup");
      await page.getByRole("link", { name: /^Open Sam's page/ }).click();
      const owner = await opened;
      await expect(owner.getByRole("heading", { level: 1 })).toHaveText(
        "Pepper's estimate from Hollins Lane Veterinary Surgery",
      );
      await owner.close();
    });

    test("an update the owner has answered is told in the past", async ({ page }) => {
      await ownerPageOf(page, "Bramble");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Rowan Hale found something and asked before going ahead.",
      );
    });

    test("a draft the model could not make says so and leaves the price list to the vet", async ({
      page,
    }) => {
      await signInAsPractice(page);
      await openNewCase(page, { patient: "Pepper", owner: "Sam Patel", procedure: "Dental" });
      await page
        .getByRole("textbox", { name: "Clinical notes" })
        .fill("Notes no recording answers: a check-up only.");
      await page.getByRole("button", { name: "Draft estimate" }).click();
      await expect(page.getByText(DRAFT_FAILED)).toBeVisible();
      await expect(page.getByRole("button", { name: "Add the item" })).toBeVisible();
    });

    test("a link whose page is slow to come shows it is on its way, and the page then arrives", async ({
      page,
    }) => {
      await signInAsPractice(page);
      await page.goto("/today");
      await page.route(/\/cases\/[^/?]+\?_rsc=/, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue();
      });
      const bramble = page.getByRole("link", { name: "Bramble" });
      await bramble.click();
      await expect(bramble.locator("[data-pending]")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: "Bramble" })).toBeVisible();
    });

    test("a page that does not exist says so in pawhold's words, with a way back", async ({
      page,
    }) => {
      await signInAsPractice(page);
      await page.goto("/cases/00000000-0000-4000-8000-000000000000");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("There's nothing here");
      await expect(page.getByRole("link", { name: "Today's cases" }).first()).toBeVisible();

      await page.goto("/no-such-page");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("There's nothing here");
      await expect(page.getByRole("link", { name: "Go to pawhold's start page" })).toBeVisible();
    });
  });
}
