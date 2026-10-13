import { expect, signInAsPractice, test } from "./fixtures";

test.describe("today's cases", () => {
  test("shows the seeded case with its chips and the next thing to do", async ({ page }) => {
    await signInAsPractice(page);
    await page.goto("/today");

    await expect(page.getByRole("heading", { level: 1, name: "Today's cases" })).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: "Bramble" });
    await expect(row.getByText("Dog", { exact: true })).toBeVisible();
    await expect(row).toContainText("Nadia Haddad");
    await expect(row).toContainText("Dental under GA");
    await expect(row.getByText("Update declined", { exact: true })).toBeVisible();
    await expect(row.getByText("Hold extended", { exact: true })).toBeVisible();
    await expect(row).toContainText("Call Nadia about the update");
    await expect(page.getByRole("banner")).toContainText("Hollins Lane Veterinary Surgery");
  });

  test("lets a visitor in through the practice's door", async ({ page }) => {
    await page.goto("/today");

    await page.getByRole("button", { name: "Try it as the practice" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Today's cases" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Bramble" })).toBeVisible();
  });

  test("opens a new case and goes to it, naming a blank field", async ({ page }) => {
    await signInAsPractice(page);
    await page.goto("/today");

    await page.getByRole("button", { name: "New case" }).click();
    const dialog = page.getByRole("dialog", { name: "Open a case" });
    await expect(dialog.getByLabel("Vet")).toHaveValue("Rowan Hale");
    const species = dialog.getByRole("combobox", { name: "Species" });
    await expect(species).toHaveValue("");
    await expect(species.getByRole("option")).toHaveText([
      "Choose the species",
      "Dog",
      "Cat",
      "Other",
    ]);
    await dialog.getByLabel("Patient").fill("Pepper");
    await dialog.getByRole("button", { name: "Open the case" }).click();
    await expect(dialog.getByLabel("Owner")).toHaveAttribute("aria-invalid", "true");
    await expect(species).toHaveAttribute("aria-invalid", "true");
    await expect(species).toHaveAccessibleDescription("Choose the species");

    await species.selectOption({ label: "Other" });
    await dialog.getByLabel("Owner").fill("Sam Patel");
    await dialog.getByLabel("Procedure").fill("Dental");
    await dialog.getByRole("button", { name: "Open the case" }).click();

    await expect(page).toHaveURL(/\/cases\/[0-9a-f-]{36}$/);
    await page.goto("/today");
    const row = page.getByRole("listitem").filter({ hasText: "Pepper" });
    await expect(row.getByText("Other", { exact: true })).toBeVisible();
    await expect(row.getByText("Estimate draft", { exact: true })).toBeVisible();
    await expect(row).toContainText("Draft the estimate");
  });
});
