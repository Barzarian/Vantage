import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const watchlists = pgTable("watchlists", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const watchlistItems = pgTable("watchlist_items", {
  id: text("id").primaryKey(),
  watchlistId: text("watchlist_id")
    .notNull()
    .references(() => watchlists.id, { onDelete: "cascade" }),
  symbol: text("symbol").notNull(),
  assetClass: text("asset_class").notNull(),
  position: integer("position").notNull(),
  note: text("note").notNull().default(""),
});

export const savedChartLayouts = pgTable("saved_chart_layouts", {
  userId: text("user_id").primaryKey(),
  layout: text("layout").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const savedChartIndicators = pgTable("saved_chart_indicators", {
  userId: text("user_id").primaryKey(),
  indicators: text("indicators").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const savedWatchlistPreferences = pgTable("saved_watchlist_preferences", {
  userId: text("user_id").primaryKey(),
  preferences: text("preferences").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
