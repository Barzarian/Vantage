import { expect, test } from "@playwright/test";

test("search, reorder, chart controls, and saved layout survive reload", async ({ page }) => {
  await page.goto("/watchlists");
  await expect(page.getByRole("heading", { level: 1, name: "Watchlists" })).toBeVisible();
  await expect(page.getByTestId("watchlist-row-AAPL")).toBeVisible();

  await page.getByRole("button", { name: /Add symbol/ }).click();
  const search = page.getByRole("textbox", { name: "Search symbols" });
  await search.fill("META");
  const metaResult = page.getByRole("button", { name: /META.*Meta Platforms/ });
  await expect(metaResult).toBeVisible();
  await metaResult.click();
  await expect(page.getByTestId("watchlist-row-META")).toBeVisible();

  const handle = page.getByTestId("watchlist-row-META").getByRole("button", { name: "Reorder META" });
  const sourceBox = await handle.boundingBox();
  const targetBox = await page.getByTestId("watchlist-row-AAPL").boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Could not locate watchlist drag targets.");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 12, sourceBox.y + sourceBox.height / 2, { steps: 3 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const rows = page.locator("tbody tr[data-testid^='watchlist-row-']");
  await expect(rows.first()).toHaveAttribute("data-testid", "watchlist-row-META");

  await page.getByRole("button", { name: "Timeframe 5m" }).click();
  await expect(page.getByRole("button", { name: "Timeframe 5m" })).toHaveClass(/bg-slate-700/);
  await page.getByRole("link", { name: /Open full chart/ }).click();

  await expect(page.getByRole("heading", { name: "META" })).toBeVisible();
  await page.getByRole("button", { name: "Add indicator" }).click();
  await page.getByRole("button", { name: "SMA", exact: true }).click();
  await expect(page.getByText("SMA", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "4 chart layout" }).click();
  await expect(page.getByTestId("price-chart-3")).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("vantage.chart.preferences"))).toContain("SMA");
  await page.waitForTimeout(700);
  await page.reload();
  console.log("Chart prefs after reload:", await page.evaluate(() => localStorage.getItem("vantage.chart.preferences")), page.url());
  await expect(page.getByTestId("layout-4")).toHaveClass(/bg-emerald-400/);
  await expect(page.getByTestId("price-chart-3")).toBeVisible();
  await expect(page.getByText(/SMA 20/).first()).toBeVisible();
});
