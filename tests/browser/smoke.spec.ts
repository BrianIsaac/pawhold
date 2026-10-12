import { expect, test } from "./fixtures";

test("the landing page carries section 6's heading", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: "Estimates your clients can say yes to." }),
  ).toBeVisible();
});
