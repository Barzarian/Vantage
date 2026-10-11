import { z } from "zod";

export const watchlistColumnSchema = z.enum([
  "symbol",
  "name",
  "last",
  "change",
  "changePercent",
  "bid",
  "ask",
  "volume",
  "dayRange",
  "weekRange",
  "sparkline",
]);
export type WatchlistColumn = z.infer<typeof watchlistColumnSchema>;

export const watchlistPreferencesSchema = z.object({
  order: z.array(watchlistColumnSchema).min(1).max(11),
  visible: z.array(watchlistColumnSchema).min(1).max(11),
  sort: z.object({
    column: watchlistColumnSchema,
    direction: z.enum(["asc", "desc"]),
  }).optional(),
});
export type WatchlistPreferences = z.infer<typeof watchlistPreferencesSchema>;

export const chartTypeSchema = z.enum(["candlestick", "line", "area", "bar"]);
export const chartRangeSchema = z.enum(["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "Max"]);
export const timeframeSchema = z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]);
export const indicatorConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["SMA", "EMA", "VWAP", "Bollinger", "RSI", "MACD"]),
  period: z.number().int().min(2).max(500).optional(),
  pane: z.enum(["overlay", "separate"]),
});
export type IndicatorConfig = z.infer<typeof indicatorConfigSchema>;

export const chartPaneSchema = z.object({
  symbol: z.string().min(1).max(32),
  timeframe: timeframeSchema,
  range: chartRangeSchema,
  type: chartTypeSchema,
  indicators: z.array(indicatorConfigSchema).max(12),
  compareSymbol: z.string().max(32).optional(),
});
export type ChartPaneConfig = z.infer<typeof chartPaneSchema>;

export const chartPreferencesSchema = z.object({
  layout: z.enum(["1", "2", "4"]),
  panes: z.array(chartPaneSchema).min(1).max(4),
  syncCrosshair: z.boolean(),
  syncTimeRange: z.boolean(),
});
export type ChartPreferences = z.infer<typeof chartPreferencesSchema>;

export const userPreferencesSchema = z.object({
  watchlist: watchlistPreferencesSchema,
  chart: chartPreferencesSchema,
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const defaultWatchlistPreferences: WatchlistPreferences = {
  order: ["symbol", "name", "last", "change", "changePercent", "bid", "ask", "volume", "dayRange", "weekRange", "sparkline"],
  visible: ["symbol", "name", "last", "change", "changePercent", "bid", "ask", "volume", "dayRange", "sparkline"],
};

export function formatPrice(value: number, symbol: string, assetClass: string): string {
  let digits = 2;
  if (assetClass === "future") {
    const tickDigits: Record<string, number> = { ES: 2, NQ: 2, CL: 2, GC: 1, ZB: 3 };
    digits = tickDigits[symbol.replace(/[FGHJKMNQUVXZ]\d{1,2}$/i, "")] ?? 2;
  }
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
