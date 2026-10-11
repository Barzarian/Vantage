import { expect, test } from "@playwright/test";

test("market overview loads watchlist and simulated-data disclaimer", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Good morning" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Core Watchlist" })).toBeVisible();
  await expect(page.getByRole("table").getByText("AAPL")).toBeVisible();
  const footer = page.locator("footer");
  await expect(footer).toContainText("Data is simulated, not live market data.");
  await expect(footer).toContainText("For informational purposes only. Not financial advice.");
});
