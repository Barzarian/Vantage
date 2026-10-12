import { expect, test } from "@playwright/test";

test("futures sector filter, term structure, continuous adjustment, and watchlist integration", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/futures");
  await expect(page.getByRole("heading", { name: "Futures markets" })).toBeVisible({ timeout: 30_000 });
  const sector = page.getByRole("combobox", { name: "Filter futures sector" });
  await sector.selectOption("energy");
  await expect(page.getByTestId("futures-row-CL")).toBeVisible();
  await expect(page.getByTestId("futures-row-ES")).toHaveCount(0);
  await sector.selectOption("equity index");
  const frontContractLink = page.getByTestId("futures-row-ES").getByRole("link").nth(1);
  const frontContract = await frontContractLink.innerText();
  await frontContractLink.click();

  await expect(page.getByRole("heading", { name: "ES", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Selected futures contract" })).toHaveValue(frontContract);
  await expect(page.getByRole("heading", { name: "Term structure" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".recharts-surface").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("price-chart-0").locator("canvas").first()).toBeVisible({ timeout: 30_000 });
  const adjustment = page.getByRole("combobox", { name: "Continuous adjustment mode" });
  await adjustment.selectOption("ratio");
  await expect(adjustment).toHaveValue("ratio");
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByRole("heading", { name: "ES", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Continuous adjustment mode" })).toHaveValue("ratio");

  const contract = await page.getByRole("combobox", { name: "Selected futures contract" }).inputValue();
  await page.getByRole("button", { name: "Add to watchlist" }).click();
  await page.goto("/watchlists");
  await expect(page.getByTestId(`watchlist-row-${contract}`)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId(`watchlist-row-${contract}`)).toBeVisible();
});
