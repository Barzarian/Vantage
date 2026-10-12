import { pgTable, text, integer, timestamp, numeric, uniqueIndex, date, boolean, jsonb, index } from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  baseCurrency: text("base_currency").notNull().default("USD"),
  fxRates: text("fx_rates").notNull().default("{}"),
  cashBalance: numeric("cash_balance").notNull().default("0"),
  lotMethod: text("lot_method").notNull().default("fifo"),
  expiryWarningDays: integer("expiry_warning_days").notNull().default(7),
  concentrationThreshold: numeric("concentration_threshold").notNull().default("0.25"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactions = pgTable("transactions", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  symbol: text("symbol").notNull(),
  assetClass: text("asset_class").notNull(),
  kind: text("kind").notNull().default("trade"),
  side: text("side"),
  quantity: numeric("quantity"),
  price: numeric("price"),
  fees: numeric("fees").notNull().default("0"),
  currency: text("currency").notNull().default("USD"),
  executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
  openClose: text("open_close"),
  notes: text("notes").notNull().default(""),
  ratioNumerator: numeric("ratio_numerator"),
  ratioDenominator: numeric("ratio_denominator"),
  amountPerShare: numeric("amount_per_share"),
  disposition: text("disposition"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const transactionAudit = pgTable("transaction_audit", {
  id: text("id").primaryKey(),
  transactionId: text("transaction_id").notNull(),
  accountId: text("account_id").notNull(),
  action: text("action").notNull(),
  before: text("before"),
  after: text("after"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
  marketValue: numeric("market_value").notNull(),
  realizedPnl: numeric("realized_pnl").notNull(),
  unrealizedPnl: numeric("unrealized_pnl").notNull(),
  delta: numeric("delta").notNull().default("0"),
  gamma: numeric("gamma").notNull().default("0"),
  theta: numeric("theta").notNull().default("0"),
  vega: numeric("vega").notNull().default("0"),
}, (table) => [uniqueIndex("portfolio_snapshots_account_date_uidx").on(table.accountId, table.snapshotDate)]);

export const savedPositionsPreferences = pgTable("saved_positions_preferences", {
  userId: text("user_id").primaryKey(),
  preferences: text("preferences").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alerts = pgTable("alerts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  assetClass: text("asset_class").notNull(),
  condition: jsonb("condition").notNull(),
  triggerMode: text("trigger_mode").notNull().default("every-cross"),
  cooldownSeconds: integer("cooldown_seconds").notNull().default(300),
  active: boolean("active").notNull().default(true),
  onlyRegularHours: boolean("only_regular_hours").notNull().default(false),
  maxJumpPercent: numeric("max_jump_percent").notNull().default("20"),
  evaluationState: jsonb("evaluation_state").notNull().default({}),
  lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
  lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("alerts_user_active_idx").on(table.userId, table.active),
  index("alerts_symbol_active_idx").on(table.symbol, table.active),
]);

export const alertEvents = pgTable("alert_events", {
  id: text("id").primaryKey(),
  alertId: text("alert_id").notNull().references(() => alerts.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  triggerValue: numeric("trigger_value"),
  summary: text("summary").notNull(),
  deliveryResults: jsonb("delivery_results").notNull().default({}),
  readAt: timestamp("read_at", { withTimezone: true }),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("alert_events_alert_idempotency_uidx").on(table.alertId, table.idempotencyKey),
  index("alert_events_user_time_idx").on(table.userId, table.triggeredAt),
  index("alert_events_user_unread_idx").on(table.userId, table.readAt),
]);

export const notificationChannels = pgTable("notification_channels", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  encryptedConfig: text("encrypted_config"),
  label: text("label").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("notification_channels_user_type_uidx").on(table.userId, table.type),
]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  endpointHash: text("endpoint_hash").notNull(),
  encryptedSubscription: text("encrypted_subscription").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("push_subscriptions_user_endpoint_uidx").on(table.userId, table.endpointHash),
]);

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

export const savedFuturesPreferences = pgTable("saved_futures_preferences", {
  userId: text("user_id").primaryKey(),
  preferences: text("preferences").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const savedStrategies = pgTable("saved_strategies", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  legs: text("legs").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
