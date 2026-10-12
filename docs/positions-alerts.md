Add Positions/P&L and Alerts features to my existing Next.js market dashboard (App Router, TypeScript strict, Tailwind, shadcn/ui, TanStack Query, TanStack Virtual, Zustand, Recharts, Drizzle + Postgres, Auth.js, Zod). Extend the existing streaming layer, tick store, `MarketDataProvider`, and the Greeks (/lib/greeks) and futures (/lib/futures) libraries. Reuse them; do not reimplement pricing or contract math.

# PART A: POSITIONS AND P&L

## 1. Data model (Drizzle, Zod-validated)
- `accounts`: id, userId, name, baseCurrency
- `transactions` (source of truth): id, accountId, symbol, assetClass (equity | option | future), side (buy | sell), quantity, price, fees, executedAt, openClose (open | close, optional), notes
- `positions` is derived from transactions, not stored by hand. Build a pure function that folds transactions into positions with average cost and realized P&L.
- Lot method configurable per account: FIFO (default), LIFO, or average cost. Support short positions and position flips through zero.

## 2. Instrument handling (pure functions, unit tested)
- Multiplier per instrument: equities 1, options 100 (from the contract), futures from the contract spec table
- Option positions: mark from mid (fall back to last), expired options auto-close at intrinsic value or zero, flagged as expired/assigned/exercised in an editable way
- Futures: P&L in ticks and dollars using tick size and tick value; margin estimate from the spec table, labeled as an estimate
- Equity: split and dividend adjustments supported as manual corporate-action entries (a transaction type), not auto-fetched
- Currency: store the native currency per instrument; show base-currency totals using a configurable FX rate, labeled as an approximation

## 3. P&L calculations
- Per position: quantity, average cost, mark, market value, unrealized P&L ($ and %), realized P&L, day P&L (vs previous close or settle, not midnight; futures use settlement time), total P&L, and % of portfolio
- Portfolio: total market value, cash-adjusted exposure, day P&L, unrealized and realized totals, and net long/short exposure
- Options and portfolio net Greeks: delta, gamma, theta, vega, aggregated with quantity and multiplier; delta-adjusted notional exposure by underlying
- Group by underlying (an equity, its options, and related futures roll up together where logical)
- Fees included in cost basis and realized P&L
- Floating-point safety: do the math in integer minor units or a decimal library (decimal.js or similar); format only at the display edge
- Tests with hand-computed fixtures: partial closes, FIFO vs LIFO vs average, short flips, option multiplier, futures tick math, option expiry, and fees

## 4. Entry and import
- Manual transaction form with a symbol picker (reuse search), validation, and edit/delete with an audit trail
- CSV import: column mapper UI, preview with row-level errors, dedupe by a hash of account, symbol, time, quantity, and price, and a dry-run mode. Provide parsers for a generic CSV, and keep the broker-specific parser interface pluggable (don't hardcode brokers beyond one example).
- CSV export of positions and transactions
- OCC option symbols and futures month-code symbols must parse correctly on import

## 5. Positions UI at /positions
- Tabs: Positions, Transactions, Performance
- Positions table (live via the tick store, per-row selectors, tick flash): symbol, type, qty, avg cost, mark, market value, day P&L, unrealized P&L ($ and %), delta, % of portfolio, days to expiry for options and futures; grouping toggle (flat, by underlying, by asset class); sort and column picker persisted per user
- Summary cards: total value, day P&L, unrealized, realized, net delta, theta per day, margin estimate
- Exposure charts (Recharts): allocation by asset class and by underlying, plus net delta by underlying
- Performance tab: cumulative realized P&L over time, P&L by symbol, win rate, average win vs loss, largest winners and losers; daily equity curve built from transactions and stored daily snapshots
- Daily snapshot job: store end-of-day portfolio value and Greeks in `portfolio_snapshots` for the equity curve
- Warnings: options expiring within N days, futures near roll or expiry, concentrated positions above a configurable threshold, and positions with missing or stale marks
- Row actions: open chart, open options chain, close position (prefills a closing transaction)
- Stale and disconnected badges, dashes for missing marks (never show zero for missing)

# PART B: ALERTS

## 1. Data model
- `alerts`: id, userId, name, symbol, assetClass, condition (JSON validated by a Zod discriminated union), status (active | paused | triggered | expired), cooldownSeconds, triggerMode (once | every_time | once_per_day), expiresAt, createdAt
- `alert_events`: id, alertId, triggeredAt, observedValue, message, deliveryResults JSON
- `notification_channels`: id, userId, type (in_app | web_push | webhook | email), config JSON (encrypted at rest for secrets), enabled
- `push_subscriptions` for web push

## 2. Condition types
- Price: crosses above, crosses below, above, below
- Percent move: day change greater than X%, or move over N minutes
- Volume spike: volume over N times the rolling average
- Indicator: RSI above or below a threshold (reuse /lib/indicators), price crossing an SMA or EMA
- Options: premium (mark) target, IV above or below a threshold, IV rank threshold if history exists, and delta crossing a level for a held contract
- Futures: calendar spread level and front-month roll warning
- Portfolio: day P&L loss limit, a position's unrealized loss percent, and net delta limit
- Support AND combinations of up to 3 conditions

## 3. Evaluation engine
- Server-side evaluator (a Node worker process or interval runner, with a clear note on how to run it in dev and production). It must NOT depend on the browser being open.
- Consume ticks through the same provider and subscription manager, subscribing to the union of symbols needed by active alerts, ref-counted
- Edge detection for "crosses": track the previous value per alert so a cross fires once, not on every tick. Persist the last state so a restart doesn't cause false triggers.
- Respect cooldowns and trigger modes; idempotent triggering so duplicates are not sent if two workers overlap (use a DB-level lock or an atomic status update)
- Evaluate indicator-based alerts on bar close by default, with an option for intrabar
- Market-hours awareness: an option to only evaluate during regular trading hours
- Data-quality guard: don't trigger on stale quotes, zero or crossed markets, or a bad tick (sanity check against a configurable max jump), and log skipped evaluations
- Auto-expire alerts for expired option contracts and futures

## 4. Delivery
- In-app: toast through SSE plus a notifications bell with unread count
- Browser web push (VAPID keys from env, service worker, permission flow with clear UX)
- Webhook: generic JSON POST with an HMAC signature header, timeout, and retry with backoff, with a Discord and Slack formatting option
- Email: via a pluggable provider interface (Resend or SMTP), configured through env
- Delivery results are recorded per channel in `alert_events`; one channel failing must not block the others
- SSRF protection for webhook URLs (block private and loopback ranges, https only in production)
- Rate limit alert creation and delivery per user

## 5. Alerts UI at /alerts
- Alert list with status chips, last triggered time, and quick pause, resume, and delete actions
- Create/edit form: symbol picker, condition builder (guided by type, with the current value shown live next to the threshold so the user can sanity-check), trigger mode, cooldown, expiry, and channels; a "test this alert" button that sends a sample notification
- Create alerts from other pages: right-click or a bell icon on watchlist rows, the chart (drag a horizontal line to set a price alert, via lightweight-charts), the options chain (premium or IV alert), and positions (stop-loss style alert)
- History tab: table of `alert_events` with filters and an export
- Notification channel settings in /settings with enable toggles and a test send

# QUALITY AND SAFETY
- Auth: every query scoped by userId; add tests proving user A cannot read or modify user B's accounts, transactions, or alerts
- Validate all inputs with Zod; secrets (webhook URLs, SMTP keys) never returned to the client in full
- Money math uses a decimal library; no floats for stored prices or quantities (use numeric columns)
- No whole-table re-render on a tick; per-row selectors
- Footer on both pages: informational only, not financial advice; P&L and margin figures are estimates and may differ from your broker's statements; alerts are not guaranteed to be delivered in real time or at all
- Never expose provider keys to the client; validate env with Zod

# TESTS
- Vitest: transaction folding and lot matching (FIFO/LIFO/average), short flips, multipliers per asset class, option expiry handling, futures tick math, net Greeks aggregation, CSV parsing and dedupe, alert condition evaluation, cross detection (fires once, no repeat), cooldown and trigger modes, stale-quote guard, webhook HMAC signing and SSRF blocking
- Playwright: import a CSV with stocks, an option, and a futures trade; verify the positions table values; add a closing transaction and verify realized P&L; create a price-cross alert against the mock provider (make the mock able to force a price move in test mode), verify the in-app toast and the history entry; pause and resume an alert

# ORDER OF WORK
Verify after each step and summarize what works:
1. Schema and migrations for accounts, transactions, snapshots, alerts, channels
2. Position-folding and P&L library with tests
3. Transaction form, CSV import and export
4. Positions table, summary cards, and live updates
5. Exposure and performance charts, snapshot job, warnings
6. Alert condition types, evaluator worker, and edge detection with tests
7. Delivery channels (in-app, push, webhook, email) with security checks
8. Alerts UI and create-from-chart/chain/watchlist entry points
9. Auth-scoping tests, Playwright tests, and known limitations