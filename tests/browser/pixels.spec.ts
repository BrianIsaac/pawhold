import type { Locator, Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { patientCase } from "@/db/schema";

import {
  expect,
  openNewCase,
  PLAN_NOTES,
  signInAsPractice,
  test,
  WIDTHS,
  type Width,
} from "./fixtures";
import {
  DAY_STATES,
  GRID_NAME,
  hourCells,
  prepareDay,
  roomNamesEdge,
  shownAs,
  STATE_WORDS,
} from "./support/day";
import { openBrowserDatabase } from "./owner/support/cases";
import { WALK_FINDING, WALK_PHOTO_PATH } from "../support/update-walk-words";

/*
 * The pixel pass's defects (U11), each held by what it measures on the page
 * at both widths: the day's hour labels in view, one line per timeline
 * event, a dialog's buttons in one row or one column, a case's title where
 * it stands with or without a button, a refused button still legible, a
 * line's code beside its name, no section left with only its heading.
 */

/**
 * A seeded case's page in a new practice.
 *
 * @param page - The page.
 * @param patient - The patient.
 */
async function openSeededCase(page: Page, patient: string): Promise<void> {
  const practiceId = await signInAsPractice(page);
  const database = openBrowserDatabase();
  try {
    const [found] = await database.db
      .select({ id: patientCase.id })
      .from(patientCase)
      .where(and(eq(patientCase.practiceId, practiceId), eq(patientCase.patientName, patient)));
    await page.goto(`/cases/${found!.id}`);
  } finally {
    await database.close();
  }
  await expect(page.getByRole("heading", { level: 1, name: patient })).toBeVisible();
}

/**
 * The boxes of each line of an element's text, as the browser lays them out.
 *
 * @param element - The element.
 * @returns One box per line, top to bottom.
 */
async function lineBoxes(element: Locator) {
  return element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rows = new Map<number, { left: number; right: number; top: number }>();
    for (const rect of range.getClientRects()) {
      if (rect.width === 0) {
        continue;
      }
      const top = Math.round(rect.top);
      const row = [...rows.keys()].find((one) => Math.abs(one - top) < rect.height / 2);
      const seen = row === undefined ? undefined : rows.get(row);
      if (seen) {
        seen.left = Math.min(seen.left, rect.left);
        seen.right = Math.max(seen.right, rect.right);
      } else {
        rows.set(top, { left: rect.left, right: rect.right, top });
      }
    }
    return [...rows.values()].sort((a, b) => a.top - b.top);
  });
}

/**
 * The contrast ratio of an element's text on its own background, with its
 * opacity laid over the white panel it sits on (WCAG 2's formula).
 *
 * @param element - The element.
 * @returns The ratio.
 */
async function textContrast(element: Locator): Promise<number> {
  return element.evaluate((node) => {
    const style = getComputedStyle(node);
    const parse = (colour: string): number[] =>
      (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const alpha = Number(style.opacity);
    const over = (channel: number): number => channel * alpha + 255 * (1 - alpha);
    const luminance = (rgb: number[]): number => {
      const [r, g, b] = rgb.map((channel) => {
        const c = over(channel) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ink = luminance(parse(style.color));
    const ground = luminance(parse(style.backgroundColor));
    return (Math.max(ink, ground) + 0.05) / (Math.min(ink, ground) + 0.05);
  });
}

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`the pixels at ${WIDTHS[width].width} px`, () => {
    test.use({ width });

    for (const state of DAY_STATES) {
      test(`every hour the day's grid shows in view has its label in view, beside the rooms, ${STATE_WORDS[state]}`, async ({
        page,
      }) => {
        await prepareDay(page, state);
        await signInAsPractice(page);
        await page.goto("/day");
        await shownAs(page, state);
        const grid = page.getByRole("region", { name: GRID_NAME });
        const edge = await roomNamesEdge(page, state);
        const view = (await grid.boundingBox())!;
        const cells = await hourCells(page, state).all();
        const hour = (await cells[1]!.boundingBox())!.x - (await cells[0]!.boundingBox())!.x;
        // As the day opens, then scrolled to an hour's start, a quarter and a half into it.
        for (const into of [null, 0, 0.25, 0.5]) {
          if (into !== null) {
            await grid.evaluate(
              (element, left) => {
                element.scrollLeft = left;
              },
              hour * (1 + into),
            );
          }
          let inView = 0;
          for (const label of cells) {
            const span = (await label.boundingBox())!;
            const [text] = await lineBoxes(label);
            const words = (await label.textContent()) ?? "";
            const shown =
              Math.min(span.x + span.width, view.x + view.width) - Math.max(span.x, edge);
            // A sliver of an hour too narrow for its label carries none: the label leaves with its hour.
            if (shown < text!.right - text!.left + 16) {
              continue;
            }
            inView += 1;
            expect(text!.left, `${words}, ${into ?? "as opened"}`).toBeGreaterThanOrEqual(
              edge - 0.5,
            );
            expect(words).toMatch(/^\d\d:00$/);
          }
          expect(inView, String(into ?? "as opened")).toBeGreaterThan(0);
        }
      });

      test(`the day opens with no booking cut under the room names, ${STATE_WORDS[state]}`, async ({
        page,
      }) => {
        await prepareDay(page, state);
        await signInAsPractice(page);
        await page.goto("/day");
        await shownAs(page, state);
        const grid = page.getByRole("region", { name: GRID_NAME });
        const edge = await roomNamesEdge(page, state);
        const bookings = await grid.getByRole("link").all();
        expect(bookings.length).toBeGreaterThan(0);
        for (const booking of bookings) {
          const box = (await booking.boundingBox())!;
          const whole = box.x >= edge - 0.5;
          const away = box.x + box.width <= edge + 0.5;
          expect(whole || away, (await booking.getAttribute("title")) ?? "").toBe(true);
        }
      });

      test(`no booking on the day is under 44 px either way, and the room names stay put as the day scrolls, ${STATE_WORDS[state]}`, async ({
        page,
      }) => {
        await prepareDay(page, state);
        await signInAsPractice(page);
        await page.goto("/day");
        await shownAs(page, state);
        const grid = page.getByRole("region", { name: GRID_NAME });
        for (const booking of await grid.getByRole("link").all()) {
          const box = (await booking.boundingBox())!;
          expect(box.width, (await booking.getAttribute("title")) ?? "").toBeGreaterThanOrEqual(
            43.5,
          );
          expect(box.height, (await booking.getAttribute("title")) ?? "").toBeGreaterThanOrEqual(
            43.5,
          );
        }
        const room = grid.locator("[data-room]").first();
        const before = (await room.boundingBox())!;
        await grid.evaluate((element) => {
          element.scrollLeft += 400;
        });
        const after = (await room.boundingBox())!;
        expect(after.x).toBeCloseTo(before.x, 0);
        expect(await grid.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        const page_ = await page.evaluate(() => [
          document.documentElement.scrollWidth,
          window.innerWidth,
        ]);
        expect(page_[0]).toBeLessThanOrEqual(page_[1]!);
      });
    }

    test("a case's title stands at the same height with or without a button beside it", async ({
      page,
    }) => {
      await openSeededCase(page, "Juno");
      const plain = await page.getByRole("heading", { level: 1 }).boundingBox();
      await openSeededCase(page, "Hazel");
      await expect(page.getByRole("link", { name: "Discharge" })).toBeVisible();
      const beside = await page.getByRole("heading", { level: 1 }).boundingBox();
      expect(beside!.y).toBe(plain!.y);
    });

    test("a line's code follows its name, never alone and indented on a line of its own", async ({
      page,
    }) => {
      await openSeededCase(page, "Bramble");
      const names = page
        .getByRole("list", { name: "Lines of version 1" })
        .locator("li p:has(> span)");
      for (const name of await names.all()) {
        const rows = await lineBoxes(name);
        const box = (await name.boundingBox())!;
        for (const row of rows.slice(1)) {
          expect(row.left).toBeLessThanOrEqual(box.x + 0.5);
        }
      }
    });

    test("a line's price stands on its name's row", async ({ page }) => {
      await openSeededCase(page, "Otis");
      const line = page.getByRole("list", { name: "Lines of version 1" }).getByRole("listitem");
      for (const one of (await line.all()).slice(0, 3)) {
        const name = (await one.locator("p").first().boundingBox())!;
        const price = (await one.getByText(/^£/).first().boundingBox())!;
        expect(Math.abs(price.y - name.y)).toBeLessThan(4);
      }
    });

    test("no section of a case is left with only its heading", async ({ page }) => {
      await openSeededCase(page, "Poppy");
      for (const section of await page.locator("main section[aria-labelledby]").all()) {
        const text = (await section.innerText()).trim();
        const heading = (await section.getByRole("heading").first().innerText()).trim();
        expect(text, heading).not.toBe(heading);
      }
    });

    test("an approved update stands beside its finding, in the estimate's columns", async ({
      page,
    }) => {
      test.skip(width === "phone", "one column at 390");
      await openSeededCase(page, "Teddy");
      const estimate = await page
        .getByRole("heading", { name: "The estimate Martin authorised, version 1" })
        .boundingBox();
      const update = await page
        .getByRole("heading", { name: "Update Martin approved, version 2" })
        .boundingBox();
      expect(Math.abs(update!.x - estimate!.x)).toBeLessThan(1);
    });

    test("each timeline event reads on one line, its details beside it, at 1440", async ({
      page,
    }) => {
      test.skip(width === "phone", "a phone wraps the line");
      await openSeededCase(page, "Otis");
      const rows = page.getByRole("region", { name: "Timeline" }).getByRole("listitem");
      for (const row of await rows.all()) {
        const line = (await row.locator("p").first().boundingBox())!;
        const summary = (await row.getByText("Show PayPal and model details").boundingBox())!;
        expect(summary.y).toBeLessThan(line.y + line.height);
        expect(summary.x).toBeGreaterThan(line.x);
      }
    });

    test("a wrapped timeline chip starts at the line's edge, with no stray indent", async ({
      page,
    }) => {
      await openSeededCase(page, "Bramble");
      const rows = page.getByRole("region", { name: "Timeline" }).getByRole("listitem");
      for (const row of await rows.all()) {
        const line = (await row.locator("p").first().boundingBox())!;
        const words = await lineBoxes(row.locator("p > span").first());
        const chip = (await row.getByText("Seeded for the demo").boundingBox())!;
        const beside = words.find((one) => Math.abs(one.top - chip.y) < chip.height);
        if (beside) {
          expect(chip.x - beside.right).toBeLessThan(12);
        } else {
          expect(chip.x).toBeLessThanOrEqual(line.x + 0.5);
        }
      }
    });

    test("the raw details give their values room to read", async ({ page }) => {
      await openSeededCase(page, "Bramble");
      await page.getByText("Show PayPal and model details").nth(5).click();
      const facts = page.locator("details[open] dl");
      const box = (await facts.boundingBox())!;
      for (const value of await facts.locator("dd").all()) {
        expect((await value.boundingBox())!.width).toBeGreaterThan(box.width * 0.55);
      }
    });

    test("a dialog's buttons stand in one row or one column", async ({ page }) => {
      await openSeededCase(page, "Bramble");
      const form = page.getByRole("region", { name: "Add an update" });
      await form.getByLabel("What did you find, and what do you recommend?").fill(WALK_FINDING);
      await form.getByLabel("Add a photo").setInputFiles(WALK_PHOTO_PATH);
      await form.getByLabel("Show the photo to the owner").check();
      await form.getByRole("button", { name: "Draft the update" }).click();
      await page.getByRole("button", { name: /^Ask Nadia to approve/ }).click();
      const dialog = page.getByRole("dialog", { name: "Ask Nadia to approve the update?" });
      await expect(dialog).toBeVisible();
      const boxes = await Promise.all(
        (await dialog.getByRole("button").all()).map(async (one) => (await one.boundingBox())!),
      );
      const oneRow = boxes.every((box) => Math.abs(box.y - boxes[0]!.y) < 1);
      const oneColumn = boxes.every(
        (box) => Math.abs(box.x - boxes[0]!.x) < 1 && Math.abs(box.width - boxes[0]!.width) < 1,
      );
      expect(oneRow || oneColumn).toBe(true);
    });

    test("the owner's wording of a line can be read whole while it is changed", async ({
      page,
    }) => {
      await signInAsPractice(page);
      await openNewCase(page, { patient: "Pepper", owner: "Sam Patel", procedure: "Dental" });
      await page.getByRole("textbox", { name: "Clinical notes" }).fill(PLAN_NOTES);
      await page.getByRole("button", { name: "Draft estimate" }).click();
      await page.getByText("Change line 3").click();
      const wording = page.locator("details[open]").getByLabel("What the owner reads");
      const fits = await wording.evaluate(
        (field) =>
          field.scrollWidth <= field.clientWidth + 1 &&
          field.scrollHeight <= field.clientHeight + 1,
      );
      expect(fits).toBe(true);
    });

    test("a confirm the seed refuses stays legible", async ({ page }) => {
      await openSeededCase(page, "Hazel");
      await page.getByRole("link", { name: "Discharge" }).click();
      const confirm = page.getByRole("button", { name: /^Confirm and charge/ });
      await expect(confirm).toBeVisible();
      expect(await textContrast(confirm)).toBeGreaterThanOrEqual(4.5);
    });

    test("the bill's head says what is held once", async ({ page }) => {
      await openSeededCase(page, "Hazel");
      await page.getByRole("link", { name: "Discharge" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Itemised bill" })).toBeVisible();
      const head = await page.locator("main").innerText();
      const before = head.slice(0, head.indexOf("Approved with the estimate"));
      expect(before.match(/£586\.00/g)).toHaveLength(1);
    });

    test("headings never end on a word alone", async ({ page }) => {
      for (const path of ["/", "/try/owner"]) {
        await page.goto(path);
        const heading = page.getByRole("heading", { level: 1 });
        await expect(heading).toBeVisible();
        const rows = await lineBoxes(heading);
        if (rows.length > 1) {
          const last = rows.at(-1)!;
          const first = rows[0]!;
          expect(last.right - last.left, path).toBeGreaterThan((first.right - first.left) * 0.3);
        }
      }
    });
  });
}
