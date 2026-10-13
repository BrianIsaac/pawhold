import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { hold, patientCase } from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { OWNER_LINK_LIFETIME_MS, ownerLink } from "@/owner/link";
import { voidAuthorization } from "@/paypal/payments";

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
import { browserSecret, openBrowserDatabase } from "./owner/support/cases";
import { checkScreen, untilPayPalDrawn } from "./support/checks";
import {
  deliverDischargeWebhooks,
  dischargedCase,
  doubleClient,
  DOUBLE_URL,
  twoHoldCase,
} from "./support/discharge";
import { approveAtTheDouble } from "./support/double-approval";

/*
 * The tour (U11): every screen and state a judge can reach, at 1440 and 390
 * px, each brought up in a practice seeded as a judge's is, and checked: no
 * serious or critical axe violation, every target at least 44 px. With
 * SHOTS_DIR set, each stop is shot full page as `{stop}-{width}.png`, for
 * reading the pixels by eye (`SHOTS_DIR=... pnpm test:browser tour`).
 */

const shots = process.env.SHOTS_DIR;

/** The seeded practice's patients, every money state of plan 3.2 among them (U9's map). */
const SEEDED_PATIENTS = [
  "Bramble",
  "Otis",
  "Archie",
  "Pip",
  "Moss",
  "Hazel",
  "Willow",
  "Biscuit",
  "Clover",
  "Juno",
  "Rufus",
  "Poppy",
  "Teddy",
  "Luna",
  "Milo",
] as const;

type SeededPatient = (typeof SEEDED_PATIENTS)[number];

/**
 * A seeded case's id, by its patient.
 *
 * @param practiceId - The practice.
 * @param patient - The patient.
 * @returns The case's id.
 */
async function caseOf(practiceId: string, patient: SeededPatient): Promise<string> {
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
 * The owner's link to a seeded case's latest sent version, as the practice
 * would send it, minted now or at the time given.
 *
 * @param practiceId - The practice.
 * @param patient - The patient.
 * @param mintedAt - When the link is minted.
 * @returns The link's path.
 */
async function ownerPathOf(
  practiceId: string,
  patient: SeededPatient,
  mintedAt: Date = new Date(),
): Promise<string> {
  const caseId = await caseOf(practiceId, patient);
  const database = openBrowserDatabase();
  try {
    const sent = (await caseEstimateVersions(database.db, practiceId, caseId)).filter(
      (version) => version.sentAt !== null,
    );
    const link = await ownerLink(
      database.db,
      { practiceId, caseId, versionId: sent.at(-1)!.id },
      { secret: browserSecret(), now: mintedAt },
    );
    return link.path;
  } finally {
    await database.close();
  }
}

/**
 * Signs in as a new seeded practice and opens a seeded case's page.
 *
 * @param page - The page.
 * @param patient - The patient.
 * @returns The practice's id.
 */
async function openSeededCase(page: Page, patient: SeededPatient): Promise<string> {
  const practiceId = await signInAsPractice(page);
  await page.goto(`/cases/${await caseOf(practiceId, patient)}`);
  await expect(page.getByRole("heading", { level: 1, name: patient })).toBeVisible();
  return practiceId;
}

/**
 * Opens a seeded case's owner page in a new practice.
 *
 * @param page - The page.
 * @param patient - The patient.
 */
async function openOwnerPage(page: Page, patient: SeededPatient): Promise<void> {
  const practiceId = await signInAsPractice(page);
  await page.goto(await ownerPathOf(practiceId, patient));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/**
 * The calendar day in London some minutes from now.
 *
 * @param minutes - Minutes from now.
 * @returns "2026-10-12".
 */
function londonDay(minutes: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + minutes * 60 * 1000));
}

/**
 * Opens the day the seeded Juno is held on, once the agent has held it.
 *
 * @param page - The page.
 * @returns The region of the agent's holds.
 */
async function openHeldDay(page: Page) {
  await signInAsPractice(page);
  await page.goto(`/day?day=${londonDay(30)}`);
  const held = page.getByRole("region", { name: "Held by pawhold" });
  await expect(held).toBeVisible();
  return held;
}

/**
 * Drafts the plan's notes into a new case.
 *
 * @param page - The page.
 */
async function draftNewCase(page: Page): Promise<void> {
  await signInAsPractice(page);
  await openNewCase(page, { patient: "Pepper", owner: "Sam Patel", procedure: "Dental" });
  await page.getByRole("textbox", { name: "Clinical notes" }).fill(PLAN_NOTES);
  await page.getByRole("button", { name: "Draft estimate" }).click();
  await expect(page.getByRole("region", { name: "Draft estimate, version 1" })).toBeVisible();
}

/**
 * Drafts the walk's update on the seeded Bramble.
 *
 * @param page - The page.
 */
async function draftBrambleUpdate(page: Page): Promise<void> {
  await openSeededCase(page, "Bramble");
  const form = page.getByRole("region", { name: "Add an update" });
  await form.getByLabel("What did you find, and what do you recommend?").fill(WALK_FINDING);
  await form.getByLabel("Add a photo").setInputFiles(WALK_PHOTO_PATH);
  await form.getByLabel("Show the photo to the owner").check();
  await form.getByRole("button", { name: "Draft the update" }).click();
  await expect(page.getByRole("region", { name: "Update, version 3" })).toBeVisible();
}

/**
 * Takes the owner door, has the owner approve Otis's hold at the double, and
 * opens Otis's bill as the practice.
 *
 * @param page - The page.
 */
async function otisBill(page: Page): Promise<void> {
  test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
  await page.goto("/");
  await page.getByRole("link", { name: "Try it as the owner" }).click();
  await approveAtTheDouble(page);
  await expect(page.getByText("Held", { exact: true })).toBeVisible();
  await page.goto("/today");
  await page.getByRole("link", { name: "Otis" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Otis" })).toBeVisible();
  await page.getByRole("link", { name: "Discharge" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Itemised bill" })).toBeVisible();
}

/** A stop: how to bring the screen to its state, and whether its shot is the viewport alone. */
interface Stop {
  readonly reach: (page: Page) => Promise<void>;
  /** A dialog's shot is of the screen as seen, not the page under it. */
  readonly viewportOnly?: boolean;
  /** What axe leaves out: PayPal's own frames, which pawhold does not draw. */
  readonly exclude?: readonly string[];
}

/** Every screen and state, by the shot's name. */
const STOPS: Record<string, Stop> = {
  landing: {
    reach: async (page) => {
      await page.goto("/");
      await expect(page.getByRole("link", { name: "Try it as the owner" })).toBeVisible();
    },
  },
  "practice-door": {
    reach: async (page) => {
      await page.goto("/");
      await page.getByRole("link", { name: "Try it as the practice" }).click();
      await expect(page.getByRole("link", { name: "Bramble" })).toBeVisible();
    },
  },
  "owner-door": {
    reach: async (page) => {
      await page.goto("/");
      await page.getByRole("link", { name: "Try it as the owner" }).click();
      await untilPayPalDrawn(page);
    },
  },
  "owner-door-held": {
    reach: async (page) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      await page.goto("/");
      await page.getByRole("link", { name: "Try it as the owner" }).click();
      await approveAtTheDouble(page);
      await expect(page.getByText(/^Done\./)).toBeVisible();
    },
  },
  "today-signed-out": {
    reach: async (page) => {
      await page.goto("/today");
      await expect(page.getByRole("button", { name: "Try it as the practice" })).toBeVisible();
    },
  },
  "today-new-case": {
    reach: async (page) => {
      await signInAsPractice(page);
      await page.goto("/today");
      await page.getByRole("button", { name: "New case" }).click();
      await page.getByRole("button", { name: "Open the case" }).click();
      await expect(
        page.getByRole("dialog", { name: "Open a case" }).getByRole("alert"),
      ).toBeVisible();
    },
    viewportOnly: true,
  },
  ...Object.fromEntries(
    SEEDED_PATIENTS.map((patient): [string, Stop] => [
      `case-${patient.toLowerCase()}`,
      { reach: async (page) => void (await openSeededCase(page, patient)) },
    ]),
  ),
  "case-bramble-details": {
    reach: async (page) => {
      await openSeededCase(page, "Bramble");
      await page.getByText("Show PayPal and model details").nth(5).click();
    },
  },
  "case-new": {
    reach: async (page) => {
      await signInAsPractice(page);
      await openNewCase(page, { patient: "Pepper", owner: "Sam Patel", procedure: "Dental" });
    },
  },
  "case-draft": { reach: draftNewCase },
  "case-draft-failed": {
    reach: async (page) => {
      await signInAsPractice(page);
      await openNewCase(page, { patient: "Pepper", owner: "Sam Patel", procedure: "Dental" });
      await page
        .getByRole("textbox", { name: "Clinical notes" })
        .fill("Notes no recording answers: a check-up only.");
      await page.getByRole("button", { name: "Draft estimate" }).click();
      await expect(page.getByText(/^The draft didn't work this time\./)).toBeVisible();
    },
  },
  "practice-not-found": {
    reach: async (page) => {
      await signInAsPractice(page);
      await page.goto("/cases/00000000-0000-4000-8000-000000000000");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("There's nothing here");
    },
  },
  "not-found": {
    reach: async (page) => {
      await page.goto("/no-such-page");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("There's nothing here");
    },
  },
  "case-draft-line-open": {
    reach: async (page) => {
      await draftNewCase(page);
      await page.getByText("Change line 3").click();
      await expect(page.getByRole("button", { name: "Save line 3" })).toBeVisible();
    },
  },
  "case-review": {
    reach: async (page) => {
      await draftNewCase(page);
      await page.getByRole("button", { name: "Send to Sam" }).click();
      await expect(page.getByRole("dialog", { name: "Send this estimate to Sam?" })).toBeVisible();
    },
    viewportOnly: true,
  },
  "case-sent": {
    reach: async (page) => {
      await draftNewCase(page);
      await page.getByRole("button", { name: "Send to Sam" }).click();
      await page
        .getByRole("dialog", { name: "Send this estimate to Sam?" })
        .getByRole("button", { name: "Send to Sam" })
        .click();
      await expect(page.getByRole("status")).toBeVisible();
    },
  },
  "update-draft": { reach: draftBrambleUpdate },
  "update-review": {
    reach: async (page) => {
      await draftBrambleUpdate(page);
      await page.getByRole("button", { name: "Ask Nadia to approve £130.00" }).click();
      await expect(
        page.getByRole("dialog", { name: "Ask Nadia to approve the update?" }),
      ).toBeVisible();
    },
    viewportOnly: true,
  },
  "update-sent": {
    reach: async (page) => {
      await draftBrambleUpdate(page);
      await page.getByRole("button", { name: "Ask Nadia to approve £130.00" }).click();
      await page
        .getByRole("dialog", { name: "Ask Nadia to approve the update?" })
        .getByRole("button", { name: "Ask Nadia to approve £130.00" })
        .click();
      await expect(page.getByRole("status")).toBeVisible();
    },
  },
  "discharge-seeded": {
    reach: async (page) => {
      await openSeededCase(page, "Hazel");
      await page.getByRole("link", { name: "Discharge" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Itemised bill" })).toBeVisible();
    },
  },
  "discharge-refused": {
    reach: async (page) => {
      await openSeededCase(page, "Bramble");
      await page.getByRole("link", { name: "Discharge" }).click();
      await page.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }).fill("3");
      const extra = page.getByRole("region", { name: "Work not on an approved estimate" });
      await extra.getByLabel("Item").selectOption({ index: 1 });
      await extra.getByRole("button", { name: "Note the work" }).click();
      await expect(extra.getByText(/not charged$/)).toBeVisible();
    },
  },
  "discharge-otis": { reach: otisBill },
  "discharge-otis-confirm": {
    reach: async (page) => {
      await otisBill(page);
      await page.getByRole("button", { name: "Confirm and charge £876.00" }).click();
      await expect(page.getByRole("dialog", { name: "Confirm the bill?" })).toBeVisible();
    },
    viewportOnly: true,
  },
  "discharge-otis-landed": {
    reach: async (page) => {
      await otisBill(page);
      await page.getByRole("button", { name: "Confirm and charge £876.00" }).click();
      await page
        .getByRole("dialog", { name: "Confirm the bill?" })
        .getByRole("button", { name: "Confirm and charge £876.00" })
        .click();
      await expect(page.getByText("£876.00 captured. £134.00 released to Priya.")).toBeVisible({
        timeout: 20_000,
      });
    },
  },
  "discharge-two-holds": {
    reach: async (page) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      const practiceId = await signInAsPractice(page);
      const database = openBrowserDatabase();
      try {
        const kase = await twoHoldCase(database.db, practiceId);
        await page.goto(`/cases/${kase.caseId}/discharge`);
      } finally {
        await database.close();
      }
      await page
        .getByRole("region", { name: "Approved with the update" })
        .getByRole("textbox", { name: "Done: Tooth extraction, surgical" })
        .fill("3");
      await expect(page.locator("#bill-verdict").getByText(/will be captured/)).toBeVisible();
    },
  },
  "discharge-confirmed": {
    reach: async (page) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      const practiceId = await signInAsPractice(page);
      const database = openBrowserDatabase();
      try {
        const kase = await dischargedCase(database.db, practiceId);
        await deliverDischargeWebhooks(database.db, kase.caseId);
        await page.goto(`/cases/${kase.caseId}/discharge`);
      } finally {
        await database.close();
      }
      await expect(page.getByText(/^Confirmed by PayPal/)).toHaveCount(3);
    },
  },
  "discharge-capture-refused": {
    reach: async (page) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      test.setTimeout(120_000);
      const practiceId = await signInAsPractice(page);
      const database = openBrowserDatabase();
      try {
        const kase = await twoHoldCase(database.db, practiceId);
        // The holds voided at PayPal behind pawhold's back: PayPal refuses
        // their capture, as it would an authorisation the buyer's bank let go.
        const held = await database.db
          .select({ authorizationId: hold.authorizationId })
          .from(hold)
          .where(eq(hold.caseId, kase.caseId));
        for (const one of held) {
          await voidAuthorization(
            doubleClient(),
            one.authorizationId!,
            `tour-void-${one.authorizationId}`,
          );
        }
        await page.goto(`/cases/${kase.caseId}/discharge`);
      } finally {
        await database.close();
      }
      await page.getByRole("button", { name: /^Confirm and charge/ }).click();
      await page
        .getByRole("dialog", { name: "Confirm the bill?" })
        .getByRole("button", { name: /^Confirm and charge/ })
        .click();
      // PayPal's refusal shows on its hold at once, or, when the page has not
      // seen it, as the stall U7 shows 45 s after the last step (U11's finding).
      await expect(
        page
          .getByText(/^PayPal refused a step/)
          .or(page.getByText(/^The discharge stopped before it finished\./))
          .first(),
      ).toBeVisible({ timeout: 75_000 });
    },
  },
  "refund-dialog": {
    reach: async (page) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      const practiceId = await signInAsPractice(page);
      const database = openBrowserDatabase();
      try {
        const kase = await dischargedCase(database.db, practiceId);
        await page.goto(`/cases/${kase.caseId}`);
      } finally {
        await database.close();
      }
      await page
        .getByRole("region", { name: "Refund" })
        .getByRole("button", { name: "Refund" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Refund Sam?" });
      await dialog.getByLabel("Amount").fill("2000");
      await dialog.getByRole("button", { name: "Refund" }).click();
      await expect(dialog.getByText("Say why: it is kept on the case's timeline.")).toBeVisible();
    },
    viewportOnly: true,
  },
  "refund-done": {
    reach: async (page) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      const practiceId = await signInAsPractice(page);
      const database = openBrowserDatabase();
      try {
        const kase = await dischargedCase(database.db, practiceId);
        await page.goto(`/cases/${kase.caseId}`);
      } finally {
        await database.close();
      }
      await page
        .getByRole("region", { name: "Refund" })
        .getByRole("button", { name: "Refund" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Refund Sam?" });
      await dialog.getByLabel("Amount").fill("25.00");
      await dialog.getByLabel("Why").fill("Goodwill: the discharge ran late");
      await dialog.getByRole("button", { name: "Refund" }).click();
      await expect(page.getByRole("status")).toBeVisible();
    },
  },
  "owner-update": { reach: (page) => openOwnerPage(page, "Juno") },
  "owner-update-declined": { reach: (page) => openOwnerPage(page, "Bramble") },
  "owner-held-paypal": { reach: (page) => openOwnerPage(page, "Hazel") },
  "owner-held-card": { reach: (page) => openOwnerPage(page, "Willow") },
  "owner-honour-over": { reach: (page) => openOwnerPage(page, "Rufus") },
  "owner-receipt-captured": { reach: (page) => openOwnerPage(page, "Poppy") },
  "owner-receipt-released": { reach: (page) => openOwnerPage(page, "Teddy") },
  "owner-receipt-refunded": { reach: (page) => openOwnerPage(page, "Luna") },
  "owner-withdrawn": { reach: (page) => openOwnerPage(page, "Milo") },
  "owner-update-withdrawn": {
    reach: async (page) => {
      const practiceId = await openSeededCase(page, "Juno");
      await page.getByRole("button", { name: "Withdraw the update" }).click();
      await page
        .getByRole("dialog", { name: "Withdraw the update?" })
        .getByRole("button", { name: "Withdraw it" })
        .click();
      await expect(page.getByRole("status")).toBeVisible();
      await page.goto(await ownerPathOf(practiceId, "Juno"));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("This update was withdrawn");
    },
  },
  "owner-expired": {
    reach: async (page) => {
      const practiceId = await signInAsPractice(page);
      await page.goto(
        await ownerPathOf(
          practiceId,
          "Otis",
          new Date(Date.now() - OWNER_LINK_LIFETIME_MS - 60_000),
        ),
      );
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link has expired");
    },
  },
  "owner-changed-link": {
    reach: async (page) => {
      await page.goto("/e/not-a-link-anyone-was-sent-0123456789");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  "day-held": {
    reach: async (page) => void (await openHeldDay(page)),
  },
  "day-moved": {
    reach: async (page) => {
      const held = await openHeldDay(page);
      const move = held.getByRole("button", { name: "Move it" });
      test.skip((await move.count()) === 0, "no move is offered late in London's evening");
      await move.click();
      await expect(held.getByRole("button", { name: "Move it" })).toHaveCount(0);
    },
  },
  "day-undone": {
    reach: async (page) => {
      const held = await openHeldDay(page);
      await held.getByRole("button", { name: "Undo" }).click();
      await expect(held).toHaveCount(0);
    },
  },
  "day-empty": {
    reach: async (page) => {
      await signInAsPractice(page);
      await page.goto(`/day?day=${londonDay(30 * 24 * 60)}`);
      await expect(page.getByText(/^Nothing is booked on/)).toBeVisible();
    },
  },
};

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`the tour at ${WIDTHS[width].width} px`, () => {
    test.use({ width });
    for (const [name, stop] of Object.entries(STOPS)) {
      test(`${name}: no serious axe violation, every target at least 44 px`, async ({ page }) => {
        await stop.reach(page);
        await checkScreen(page, stop.exclude ?? ["iframe"]);
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: join(shots, `${name}-${WIDTHS[width].width}.png`),
            fullPage: !stop.viewportOnly,
          });
        }
      });
    }
  });
}
