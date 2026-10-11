import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import {
  savedChartIndicators,
  savedChartLayouts,
  savedWatchlistPreferences,
} from "@/db/schema";
import {
  defaultWatchlistPreferences,
  userPreferencesSchema,
  type UserPreferences,
} from "./preferences";

const USER_ID = "local-user";

const defaults: UserPreferences = {
  watchlist: defaultWatchlistPreferences,
  chart: {
    layout: "1",
    panes: [{
      symbol: "AAPL",
      timeframe: "1m",
      range: "1D",
      type: "candlestick",
      indicators: [],
    }],
    syncCrosshair: true,
    syncTimeRange: false,
  },
};

declare global {
  var localUserPreferences: UserPreferences | undefined;
}

export async function getUserPreferences(): Promise<UserPreferences> {
  const database = getDatabase();
  if (!database) return userPreferencesSchema.parse(globalThis.localUserPreferences ?? defaults);
  const [watchlistRows, layoutRows, indicatorRows] = await Promise.all([
    database.db.select().from(savedWatchlistPreferences).where(eq(savedWatchlistPreferences.userId, USER_ID)).limit(1),
    database.db.select().from(savedChartLayouts).where(eq(savedChartLayouts.userId, USER_ID)).limit(1),
    database.db.select().from(savedChartIndicators).where(eq(savedChartIndicators.userId, USER_ID)).limit(1),
  ]);
  let current = defaults;
  try {
    current = userPreferencesSchema.parse({
      watchlist: watchlistRows[0] ? JSON.parse(watchlistRows[0].preferences) : defaults.watchlist,
      chart: layoutRows[0]
        ? {
            ...JSON.parse(layoutRows[0].layout),
            indicators: indicatorRows[0] ? JSON.parse(indicatorRows[0].indicators) : undefined,
          }
        : defaults.chart,
    });
  } catch (error) {
    console.error(`[preferences] Stored preferences are invalid: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return current;
}

export async function saveUserPreferences(value: UserPreferences): Promise<UserPreferences> {
  const preferences = userPreferencesSchema.parse(value);
  const database = getDatabase();
  if (!database) {
    globalThis.localUserPreferences = preferences;
    return preferences;
  }
  await Promise.all([
    database.db.insert(savedWatchlistPreferences).values({
      userId: USER_ID,
      preferences: JSON.stringify(preferences.watchlist),
    }).onConflictDoUpdate({
      target: savedWatchlistPreferences.userId,
      set: { preferences: JSON.stringify(preferences.watchlist), updatedAt: new Date() },
    }),
    database.db.insert(savedChartLayouts).values({
      userId: USER_ID,
      layout: JSON.stringify({
        layout: preferences.chart.layout,
        panes: preferences.chart.panes,
        syncCrosshair: preferences.chart.syncCrosshair,
        syncTimeRange: preferences.chart.syncTimeRange,
      }),
    }).onConflictDoUpdate({
      target: savedChartLayouts.userId,
      set: {
        layout: JSON.stringify({
          layout: preferences.chart.layout,
          panes: preferences.chart.panes,
          syncCrosshair: preferences.chart.syncCrosshair,
          syncTimeRange: preferences.chart.syncTimeRange,
        }),
        updatedAt: new Date(),
      },
    }),
    database.db.insert(savedChartIndicators).values({
      userId: USER_ID,
      indicators: JSON.stringify(preferences.chart.panes.map((pane) => pane.indicators)),
    }).onConflictDoUpdate({
      target: savedChartIndicators.userId,
      set: {
        indicators: JSON.stringify(preferences.chart.panes.map((pane) => pane.indicators)),
        updatedAt: new Date(),
      },
    }),
  ]);
  return preferences;
}

export { defaults as defaultUserPreferences };
