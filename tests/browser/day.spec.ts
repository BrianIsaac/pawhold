import { join } from "node:path";

import type { Page } from "@playwright/test";
import { and, asc, eq, inArray } from "drizzle-orm";

import { auditEvent, booking, hold, patientCase } from "@/db/schema";
import { caseEstimateVersions } from "@/estimate/version";
import { reconcileWebhookEvent } from "@/money/reconcile";
import { ownerLink } from "@/owner/link";

import { DAY_ROOMS } from "../../seed/practice/day";
import { storeDelivery } from "../support/webhook-delivery";
import { expect, signInAsPractice, test, WIDTHS, type Width } from "./fixtures";
import { browserSecret, openBrowserDatabase } from "./owner/support/cases";
import { checkScreen } from "./support/checks";
import {
  bookingOf,
  DAY_STATES,
  GRID_NAME,
  londonDay,
  londonDayOf,
  openHeldDay,
  prepareDay,
  SCHEDULER_MODULE,
  shownAs,
  STATE_WORDS,
} from "./support/day";
import { DOUBLE_URL } from "./support/discharge";
import { approveAtTheDouble } from "./support/double-approval";

/*
 * The practice's day (U8a, U8b): the seeded day on the board, Bryntum's
 * Scheduler, and on the plain timeline under it, at 1440 and 390 px; the
 * agent's hold and its move answered by the practice's clicks; a case's
 * colour following its money without a reload; and the day staying on the
 * plain timeline whenever the Scheduler fails, throws, takes too long or
 * shows that its trial has expired.
 */

/** The seeded day's patients: the showcase case's check and the day's seven cases. */
const SEEDED_PATIENTS = ["Archie", "Biscuit", "Bramble", "Clover", "Juno", "Moss", "Pip", "Willow"];

/** Full-page shots for the handover when set (`SHOTS_DIR=... pnpm test:browser day`). */
const shots = process.env.SHOTS_DIR;

/** A day past both readings of the trial's length, in milliseconds. */
const PAST_THE_TRIAL_MS = 46 * 24 * 60 * 60 * 1000;

/**
 * A seeded patient's case and the day in London its procedure is booked on.
 *
 * @param practiceId - The practice.
 * @param patient - The patient.
 * @returns The case and the day.
 */
async function procedureOf(
  practiceId: string,
  patient: string,
): Promise<{ caseId: string; day: string }> {
  const database = openBrowserDatabase();
  try {
    const [found] = await database.db
      .select({ caseId: patientCase.id, startsAt: booking.startsAt })
      .from(booking)
      .innerJoin(patientCase, eq(patientCase.id, booking.caseId))
      .where(
        and(
          eq(booking.practiceId, practiceId),
          eq(booking.kind, "procedure"),
          eq(patientCase.patientName, patient),
        ),
      );
    return { caseId: found!.caseId, day: londonDayOf(found!.startsAt) };
  } finally {
    await database.close();
  }
}

/**
 * The owner's link to a case's latest sent estimate, as the practice sends it.
 *
 * @param practiceId - The practice.
 * @param caseId - The case.
 * @returns The link's path.
 */
async function ownerPathOf(practiceId: string, caseId: string): Promise<string> {
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
 * PayPal's webhook for a case's authorised hold, stored as the listener
 * stores it and reconciled as it reconciles it (a walk cannot post a signed
 * delivery: its certificate must come from PayPal's own host).
 *
 * @param caseId - The case.
 * @returns What the reconciliation did.
 */
async function deliverAuthorisationWebhook(caseId: string): Promise<string> {
  const database = openBrowserDatabase();
  try {
    const [held] = await database.db
      .select()
      .from(hold)
      .where(and(eq(hold.caseId, caseId), eq(hold.status, "authorised")))
      .orderBy(asc(hold.versionNumber));
    const event = await storeDelivery(
      database.db,
      "PAYMENT.AUTHORIZATION.CREATED",
      held!.authorizationId!,
    );
    return (await reconcileWebhookEvent(database.db, event)).outcome;
  } finally {
    await database.close();
  }
}

/**
 * The schedule's audit events on some cases, oldest first.
 *
 * @param caseIds - The cases.
 * @param actions - The actions asked after.
 * @returns Each event's action and case.
 */
async function scheduleEvents(
  caseIds: readonly string[],
  actions: readonly string[],
): Promise<{ action: string; caseId: string | null; actor: string }[]> {
  const database = openBrowserDatabase();
  try {
    return await database.db
      .select({ action: auditEvent.action, caseId: auditEvent.caseId, actor: auditEvent.actor })
      .from(auditEvent)
      .where(
        and(inArray(auditEvent.caseId, [...caseIds]), inArray(auditEvent.action, [...actions])),
      )
      .orderBy(asc(auditEvent.id));
  } finally {
    await database.close();
  }
}

/**
 * Marks the document a page is showing, so a walk can tell that what it sees
 * later is the same document changed in place, not one loaded again.
 *
 * @param page - The page.
 * @returns Reads whether the mark still stands.
 */
async function markDocument(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    (window as unknown as { pawholdWalkMark?: boolean }).pawholdWalkMark = true;
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { pawholdWalkMark?: boolean }).pawholdWalkMark === true,
    );
}

for (const width of Object.keys(WIDTHS) as Width[]) {
  for (const state of DAY_STATES) {
    test.describe(`the practice's day at ${WIDTHS[width].width} px, ${STATE_WORDS[state]}`, () => {
      test.use({ width });
      test.beforeEach(async ({ page }) => prepareDay(page, state));

      test(
        state === "board"
          ? "the board renders the seeded day: its rooms in order, every booking coloured by its case's money"
          : "the plain view shows every booking of the seeded day, each coloured by its case's money",
        async ({ page }) => {
          await signInAsPractice(page);
          const days = [...new Set([londonDay(-180), londonDay(0), londonDay(180)])];
          const seen = new Map<string, string | null>();
          for (const day of days) {
            await page.goto(`/day?day=${day}`);
            await shownAs(page, state);
            const grid = page.getByRole("region", { name: GRID_NAME });
            await expect(grid.locator("[data-room]")).toHaveText(
              DAY_ROOMS.map((room) => room.name),
            );
            for (const link of await grid.getByRole("link").all()) {
              const name = (await link.textContent()) ?? "";
              const patient = SEEDED_PATIENTS.find((one) => name.includes(one));
              if (patient) {
                seen.set(patient, await link.getAttribute("data-tone"));
              }
            }
          }

          expect([...seen.keys()].sort()).toEqual(SEEDED_PATIENTS);
          expect(seen.get("Juno")).toBe("update_awaiting_owner");
          expect(seen.get("Biscuit")).toBe("held");
          expect(seen.get("Archie")).toBe("awaiting_owner");
          expect(seen.get("Pip")).toBe("estimate_draft");
          expect(seen.get("Bramble")).toBe("update_declined");
          await expect(
            page
              .getByRole("navigation", { name: "Practice" })
              .getByRole("link", { name: "The day" }),
          ).toHaveAttribute("aria-current", "page");
        },
      );

      test("today has its now line across the rooms, and another day has none", async ({
        page,
      }) => {
        await signInAsPractice(page);
        await page.goto("/day");
        await shownAs(page, state);
        const grid = page.getByRole("region", { name: GRID_NAME });
        await expect(grid.locator(".day-now")).toHaveCount(1);

        await page.goto(`/day?day=${londonDay(3 * 24 * 60)}`);
        await shownAs(page, state);
        await expect(page.getByRole("region", { name: GRID_NAME }).locator(".day-now")).toHaveCount(
          0,
        );
      });

      test("the agent holds the slot at once; Move it, the practice's click, moves the next procedure into it and writes its audit events", async ({
        page,
      }) => {
        const { practiceId, slot, moveOffered } = await openHeldDay(page, state);
        const held = page.getByRole("region", { name: "Held by pawhold" });
        await expect(held).toContainText("Held by pawhold at");
        if (!moveOffered) {
          await expect(held.getByRole("button", { name: "Move it" })).toHaveCount(0);
          test.skip(true, "started late in London's evening: Biscuit's procedure is tomorrow");
        }
        await expect(held).toContainText("Ellis hasn't approved the update for Juno.");
        await expect(held).toContainText(
          `Move Biscuit's procedure to ${slot}, after Juno's update is answered?`,
        );
        await expect(bookingOf(page, "Juno")).toContainText("Held by pawhold");
        await expect(bookingOf(page, "Juno")).toHaveAttribute("data-held", "");
        await expect(bookingOf(page, "Juno")).toContainText(`${slot} to`);
        await expect(bookingOf(page, "Biscuit")).toContainText(`Move to ${slot} proposed`);
        await expect(bookingOf(page, "Biscuit")).toHaveAttribute("data-move", "");
        await expect(bookingOf(page, "Biscuit")).not.toContainText(`${slot} to`);
        if (shots) {
          await page.screenshot({
            path: join(shots, `day-held-${state}-${WIDTHS[width].width}.png`),
            fullPage: true,
          });
        }
        const juno = await procedureOf(practiceId, "Juno");
        const biscuit = await procedureOf(practiceId, "Biscuit");
        const moves = ["schedule.move_applied", "schedule.booking_moved"];
        expect(await scheduleEvents([juno.caseId, biscuit.caseId], moves)).toEqual([]);

        await held.getByRole("button", { name: "Move it" }).click();

        await expect(bookingOf(page, "Biscuit")).toContainText(`${slot} to`);
        await expect(bookingOf(page, "Biscuit")).not.toContainText("proposed");
        await expect(bookingOf(page, "Juno")).not.toContainText(`${slot} to`);
        await expect(bookingOf(page, "Juno")).toContainText("Held by pawhold");
        await expect(held.getByRole("button", { name: "Move it" })).toHaveCount(0);
        await expect(held.getByRole("button", { name: "Undo" })).toBeVisible();
        await shownAs(page, state);
        expect(await scheduleEvents([juno.caseId, biscuit.caseId], moves)).toEqual([
          { action: "schedule.move_applied", caseId: juno.caseId, actor: "vet" },
          { action: "schedule.booking_moved", caseId: biscuit.caseId, actor: "vet" },
        ]);
        if (shots) {
          await page.screenshot({
            path: join(shots, `day-moved-${state}-${WIDTHS[width].width}.png`),
            fullPage: true,
          });
        }
      });

      test("Undo releases the hold with one click, and its move with it", async ({ page }) => {
        const { moveOffered } = await openHeldDay(page, state);
        const held = page.getByRole("region", { name: "Held by pawhold" });

        await held.getByRole("button", { name: "Undo" }).click();

        await expect(held).toHaveCount(0);
        await expect(bookingOf(page, "Juno")).not.toContainText("Held by pawhold");
        if (moveOffered) {
          await expect(bookingOf(page, "Biscuit")).not.toContainText("proposed");
        }
        await page.reload();
        await expect(page.getByText(/pawhold checked the day at/)).toBeVisible();
        await shownAs(page, state);
        await expect(page.getByRole("region", { name: "Held by pawhold" })).toHaveCount(0);
      });

      test("Dismiss keeps the hold and drops the move", async ({ page }) => {
        const { moveOffered } = await openHeldDay(page, state);
        test.skip(
          !moveOffered,
          "started late in London's evening: Biscuit's procedure is tomorrow",
        );
        const held = page.getByRole("region", { name: "Held by pawhold" });

        await held.getByRole("button", { name: "Dismiss" }).click();

        await expect(held.getByRole("button", { name: "Move it" })).toHaveCount(0);
        await expect(held.getByRole("button", { name: "Undo" })).toBeVisible();
        await expect(bookingOf(page, "Juno")).toContainText("Held by pawhold");
        await expect(bookingOf(page, "Biscuit")).not.toContainText("proposed");
      });

      test("a case turning held by PayPal's answer, confirmed by its webhook, recolours without a reload", async ({
        page,
        context,
      }) => {
        test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
        const practiceId = await signInAsPractice(page);
        const archie = await procedureOf(practiceId, "Archie");
        await page.goto(`/day?day=${archie.day}`);
        await shownAs(page, state);
        await expect(bookingOf(page, "Archie")).toHaveAttribute("data-tone", "awaiting_owner");
        await expect(bookingOf(page, "Archie")).toContainText("Waiting for owner");
        const sameDocument = await markDocument(page);

        const owner = await context.newPage();
        await owner.goto(await ownerPathOf(practiceId, archie.caseId));
        await approveAtTheDouble(owner);
        expect(await deliverAuthorisationWebhook(archie.caseId)).toBe("reconciled");
        await owner.close();

        await expect(bookingOf(page, "Archie")).toHaveAttribute("data-tone", "held");
        await expect(bookingOf(page, "Archie")).toContainText(/Held £\d/);
        expect(await sameDocument()).toBe(true);
        await shownAs(page, state);
      });

      test("axe finds no serious violation and every target is at least 44 px: the day with a hold", async ({
        page,
      }) => {
        await openHeldDay(page, state);

        await checkScreen(page);
      });
    });
  }

  test.describe(`the day's floor at ${WIDTHS[width].width} px`, () => {
    test.use({ width });

    test("the board asks no other host for anything", async ({ page, baseURL }) => {
      const elsewhere = new Set<string>();
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (/^https?:$/.test(url.protocol) && url.origin !== new URL(baseURL!).origin) {
          elsewhere.add(url.origin);
        }
      });
      await openHeldDay(page, "board");

      await page.waitForLoadState("networkidle");
      expect([...elsewhere]).toEqual([]);
    });

    test("stays on the plain timeline, with no error shown, when the Scheduler fails to load", async ({
      page,
    }) => {
      await prepareDay(page, "plain");
      await openHeldDay(page, "plain");

      const board = page.locator("[data-day-board]");
      await expect(board).toHaveAttribute("data-fallback", "failed");
      await expect(page.getByRole("region", { name: GRID_NAME }).getByRole("link")).not.toHaveCount(
        0,
      );
      await expect(page.locator(".b-scheduler")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1, name: "The day" })).toBeVisible();
    });

    test("goes back to the plain timeline when the Scheduler throws as it draws", async ({
      page,
    }) => {
      await page.route(SCHEDULER_MODULE, (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: [
            "export class Widget {}",
            "export const DomHelper = {};",
            "export const StringHelper = {};",
            "export class Scheduler { constructor() { throw new Error('the Scheduler threw'); } }",
          ].join("\n"),
        }),
      );
      await openHeldDay(page, "plain");

      await expect(page.locator("[data-day-board]")).toHaveAttribute("data-fallback", "failed");
      await expect(bookingOf(page, "Juno")).toContainText("Held by pawhold");
      await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0);
    });

    test("goes back to the plain timeline when the Scheduler shows that its trial has expired", async ({
      page,
    }) => {
      await openHeldDay(page, "board");

      await page.clock.install({ time: new Date(Date.now() + PAST_THE_TRIAL_MS) });
      await page.reload();

      const board = page.locator("[data-day-board]");
      await expect(board).toHaveAttribute("data-fallback", "expired");
      await expect(board).toHaveAttribute("data-day-board", "plain");
      await expect(page.locator(".b-scheduler")).toHaveCount(0);
      await expect(bookingOf(page, "Juno")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0);
    });
  });
}

test.describe("the day's floor: a Scheduler that takes too long", () => {
  test("stays on the plain timeline when the Scheduler has not drawn in ten seconds, and is not swapped late", async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(SCHEDULER_MODULE, async (route) => {
      await held;
      await route.continue();
    });
    await signInAsPractice(page);
    await page.goto(`/day?day=${londonDay(30)}`);
    const board = page.locator("[data-day-board]");
    await expect(board).toHaveAttribute("data-day-board", "plain");
    await expect(board).not.toHaveAttribute("data-fallback", /./);

    await expect(board).toHaveAttribute("data-fallback", "timeout", { timeout: 15_000 });
    release();
    await page.waitForResponse((response) => response.url().endsWith("/day/scheduler"));
    await page.waitForTimeout(1_000);

    await expect(board).toHaveAttribute("data-day-board", "plain");
    await expect(page.locator(".b-scheduler")).toHaveCount(0);
  });
});
