import { expect, signInAsPractice, test, WIDTHS, type Width } from "./fixtures";
import { openBrowserDatabase } from "./owner/support/cases";
import {
  deliverDischargeWebhooks,
  dischargedCase,
  DOUBLE_URL,
  receiptPath,
  twoHoldCase,
} from "./support/discharge";

/*
 * The discharge page (U7), walked at 1440 and 390 px. The seeded showcase
 * case Bramble is held on a seeded hold (its PayPal ids are not PayPal's),
 * so its bill can be made and judged but never charged.
 */

for (const width of Object.keys(WIDTHS) as Width[]) {
  test.describe(`at ${WIDTHS[width].width} px`, () => {
    test.use({ width });

    test("the bill lists the approved lines at the estimate's low, refuses work off the estimate and a quantity above the approval", async ({
      page,
    }) => {
      await signInAsPractice(page);
      await page.goto("/today");
      await page.getByRole("link", { name: "Bramble" }).click();
      await page.getByRole("link", { name: "Discharge" }).click();

      await expect(page.getByRole("heading", { level: 1, name: "Itemised bill" })).toBeVisible();
      const approved = page.getByRole("region", { name: "Approved with the estimate" });
      await expect(approved.getByRole("listitem")).toHaveCount(7);
      await expect(
        approved.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }),
      ).toHaveValue("0");
      const total = page.getByRole("region", { name: "Total" });
      await expect(total.getByRole("definition").first()).toHaveText("£731.00");
      await expect(total.getByRole("definition").nth(1)).toHaveText("£927.00");

      await approved.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }).fill("3");
      await expect(
        approved.getByText("3 done, 2 approved. Send an update to charge the rest."),
      ).toBeVisible();

      const extra = page.getByRole("region", { name: "Work not on an approved estimate" });
      await extra.getByLabel("Item").selectOption({ index: 1 });
      await extra.getByRole("button", { name: "Note the work" }).click();
      await expect(
        extra.getByText("Not on an approved estimate. Send an update to charge it."),
      ).toBeVisible();
      await expect(extra.getByText(/not charged$/)).toBeVisible();
    });

    test("the allocation is shown before confirming, and a bill above the holds says why it cannot be confirmed", async ({
      page,
    }) => {
      await signInAsPractice(page);
      await page.goto("/today");
      await page.getByRole("link", { name: "Bramble" }).click();
      await page.getByRole("link", { name: "Discharge" }).click();

      const total = page.getByRole("region", { name: "Total" });
      await expect(
        total.getByText(
          "£731.00 will be captured from the hold. £196.00 will be released to Nadia.",
        ),
      ).toBeVisible();
      await expect(total.getByText(/seeded for the demo/)).toBeVisible();
      await expect(
        total.getByRole("button", { name: "Confirm and charge £731.00" }),
      ).toBeDisabled();

      await page.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }).fill("5");
      await expect(
        total.getByText(
          "The bill is £1,221.00, above the £927.00 held. Nothing above a hold is charged: send an update for the rest, or change the bill.",
        ),
      ).toBeVisible();
      await expect(total.getByText(/will be captured/)).toHaveCount(0);
      await expect(
        total.getByRole("button", { name: "Confirm and charge £1,221.00" }),
      ).toBeDisabled();
    });

    test("a quantity typed before the page has come alive is read into the bill once it has", async ({
      page,
    }) => {
      const faults: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          faults.push(message.text());
        }
      });
      page.on("pageerror", (error) => faults.push(String(error)));
      await signInAsPractice(page);
      await page.goto("/today");
      const bramble = await page.getByRole("link", { name: "Bramble" }).getAttribute("href");
      // The page arrives as the server drew it; its scripts are held back, as on a slow line.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(/\/_next\/static\/.*\.js(\?|$)/, async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(`${bramble}/discharge`, { waitUntil: "commit" });
      const approved = page.getByRole("region", { name: "Approved with the estimate" });
      await approved.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }).fill("5");

      release();

      const total = page.getByRole("region", { name: "Total" });
      await expect(
        total.getByText(
          "The bill is £1,221.00, above the £927.00 held. Nothing above a hold is charged: send an update for the rest, or change the bill.",
        ),
      ).toBeVisible();
      await expect(
        approved.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }),
      ).toHaveValue("5");
      expect(faults).toEqual([]);
    });

    test("confirm and charge: each hold's capture and release land, then PayPal's tick on each", async ({
      page,
    }) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      const practiceId = await signInAsPractice(page);
      const database = openBrowserDatabase();
      try {
        const kase = await twoHoldCase(database.db, practiceId);
        await page.goto(`/cases/${kase.caseId}/discharge`);

        await expect(
          page.getByRole("region", { name: "Approved with the estimate" }).getByRole("listitem"),
        ).toHaveCount(6);
        const update = page.getByRole("region", { name: "Approved with the update" });
        await update.getByRole("textbox", { name: "Done: Tooth extraction, surgical" }).fill("3");
        const total = page.getByRole("region", { name: "Total" });
        await expect(
          total
            .locator("#bill-verdict")
            .getByText(
              "£1,057.00 will be captured: £927.00 from the first hold, £130.00 from the update's hold. £98.00 will be released to Sam.",
            ),
        ).toBeVisible();

        await total.getByRole("button", { name: "Confirm and charge £1,057.00" }).click();
        const dialog = page.getByRole("dialog", { name: "Confirm the bill?" });
        await dialog.getByRole("button", { name: "Confirm and charge £1,057.00" }).click();

        const discharge = page.getByRole("region", { name: "Discharged" });
        await expect(discharge).toBeVisible({ timeout: 20_000 });
        await expect(
          discharge.getByText("£1,057.00 captured. £98.00 released to Sam."),
        ).toBeVisible();
        await expect(discharge.getByText(/^Captured £927\.00 at \d\d:\d\d:\d\d$/)).toBeVisible();
        await expect(discharge.getByText(/^Captured £130\.00 at /)).toBeVisible();
        await expect(discharge.getByText(/^Released £98\.00 to Sam at /)).toBeVisible();
        await expect(discharge.getByText("Waiting for PayPal to confirm")).toHaveCount(3);

        expect(await deliverDischargeWebhooks(database.db, kase.caseId)).toBe(2);
        await expect(discharge.getByText(/^Confirmed by PayPal \d\d:\d\d:\d\d$/)).toHaveCount(3, {
          timeout: 10_000,
        });
        await expect(discharge.getByText("Waiting for PayPal to confirm")).toHaveCount(0);

        await page.getByRole("link", { name: "Pepper's case" }).click();
        await expect(page.getByText("Released £98.00", { exact: true })).toBeVisible();
      } finally {
        await database.close();
      }
    });

    test("a refund after discharge, from the case page, appears on the timeline and the owner's receipt", async ({
      page,
    }) => {
      test.skip(!DOUBLE_URL, "the run talks to PayPal's sandbox: the double's walk is skipped");
      const practiceId = await signInAsPractice(page);
      const database = openBrowserDatabase();
      try {
        const kase = await dischargedCase(database.db, practiceId);
        await page.goto(`/cases/${kase.caseId}`);

        const refund = page.getByRole("region", { name: "Refund" });
        await refund.getByRole("button", { name: "Refund" }).click();
        const dialog = page.getByRole("dialog", { name: "Refund Sam?" });
        await expect(dialog.getByLabel("From")).toHaveValue(kase.firstCaptureId);
        await expect(dialog.getByLabel("Amount")).toHaveValue("927.00");
        await dialog.getByLabel("Amount").fill("2000");
        await dialog.getByRole("button", { name: "Refund" }).click();
        await expect(dialog.getByText("Say why: it is kept on the case's timeline.")).toBeVisible();
        await expect(
          dialog.getByText("At most £927.00 is left to refund from this charge."),
        ).toBeVisible();
        await dialog.getByLabel("Amount").fill("25.00");
        await dialog.getByLabel("Why").fill("Goodwill: the discharge ran late");
        await dialog.getByRole("button", { name: "Refund" }).click();

        await expect(page.getByRole("status")).toHaveText(
          "Refunded to Sam. The timeline and Sam's receipt show it.",
        );
        const timeline = page.getByRole("region", { name: "Timeline" });
        await expect(
          timeline.getByText('asked PayPal to refund £25.00: "Goodwill: the discharge ran late"'),
        ).toBeVisible();
        await expect(timeline.getByText(/refunded £25\.00/)).toBeVisible();

        await page.goto(await receiptPath(database.db, kase));
        await expect(
          page.getByText("That is £1,057.00 charged at discharge, less £25.00 refunded to you."),
        ).toBeVisible();
        await expect(
          page.getByText(
            "You paid £1,032.00 for Pepper's treatment. £98.00 of what was held has been released.",
          ),
        ).toBeVisible();
      } finally {
        await database.close();
      }
    });
  });
}
