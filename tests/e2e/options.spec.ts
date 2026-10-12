import { expect, test } from "@playwright/test";

test("options chain filters, builds a vertical, and restores a saved strategy", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/options/SPY");
  await expect(page.getByRole("heading", { name: "SPY", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Expiry/ }).first()).toBeVisible();
  await expect(page.getByText("Option chain", { exact: false })).toBeVisible();

  const expiryButtons = page.getByRole("button", { name: /^Expiry \d{4}-\d{2}-\d{2}$/ });
  await expiryButtons.nth(1).click();
  await expect(page.locator("[data-testid^='option-strike-']").first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole("spinbutton", { name: "Min delta" }).fill("0");
  await page.getByRole("spinbutton", { name: "Max delta" }).fill("0.5");
  await expect(page.getByText(/\d+ strikes/)).toBeVisible();

  await page.getByTitle("Buy call at ask").first().click();
  await page.getByTitle("Sell call at bid").nth(1).click();
  await expect(page.getByText("Call", { exact: false }).first()).toBeVisible();
  const name = page.getByRole("textbox", { name: "Strategy name" });
  await name.fill("Browser vertical");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("combobox", { name: "Load saved strategy" })).toContainText("Browser vertical");
  await page.reload();
  await expect(page.getByRole("heading", { name: "SPY", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Load saved strategy" }).selectOption({ label: "Browser vertical" });
  await expect(page.getByText(/SPY \d{4}-\d{2}-\d{2} \d+ CALL/).first()).toBeVisible();
});
