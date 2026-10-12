Build a real-time market monitoring dashboard for stocks, futures, and options using Next.js (App Router, latest stable), TypeScript in strict mode, Tailwind CSS, and shadcn/ui.

## Goals
A single-user (multi-user ready) dashboard where I can watch live prices, track positions and P&L, inspect options chains, monitor futures curves, and get alerts. It should be fast, dense, and keyboard-friendly, in the style of a trading terminal.

## Stack
- Next.js App Router, React Server Components where useful, client components for live data
- TanStack Query for REST data, a WebSocket layer for streaming
- Zustand for UI and watchlist state
- TradingView lightweight-charts for price charts, Recharts for secondary charts (IV skew, term structure, P&L)
- Postgres with Drizzle ORM for watchlists, alerts, positions, and saved layouts
- Auth.js (credentials or OAuth)
- Zod for validating all external data
- Vitest and Playwright for tests

## Data layer (provider-agnostic)
Define a `MarketDataProvider` interface with these methods, and implement it behind an adapter so providers can be swapped via env vars:
- `getQuote(symbols)`
- `getBars(symbol, timeframe, range)`
- `getOptionChain(underlying, expiry?)`
- `getFuturesCurve(root)`
- `subscribe(symbols, onTick)`

Ship with a mock provider that generates realistic random-walk data, so the app runs with zero API keys. Add one real adapter (Polygon.io or Alpaca, configurable) with an `.env.example`. Note that provider keys must stay server-side: proxy through route handlers, and fan WebSocket data out through a server-side relay (SSE or WS) rather than exposing vendor credentials to the browser.

## Features

### 1. Watchlists
- Multiple named watchlists mixing stocks, futures, and options contracts
- Columns: last, change, % change, bid/ask, volume, day range, 52-week range, sparkline
- Flash green/red on tick, sortable and customizable columns, drag to reorder
- Symbol search with autocomplete (Cmd+K)

### 2. Charts
- Candlestick/line/area, timeframes from 1m to 1M
- Indicators: VWAP, SMA/EMA, RSI, MACD, Bollinger Bands
- Multi-chart grid layout (1, 2, 4 panes) with synced crosshair
- Compare/overlay symbols

### 3. Options
- Full chain view: calls and puts side by side, strikes centered on the money
- Columns: bid, ask, last, volume, open interest, IV, delta, gamma, theta, vega
- Compute Greeks client-side with Black-Scholes if the provider doesn't supply them
- IV skew chart and IV term structure chart
- Expiry selector, ITM/OTM highlighting, filters by delta, volume, and OI
- Strategy builder: add legs (vertical, straddle, iron condor, custom), then show a payoff diagram at expiry and at T+n, with max profit/loss, breakevens, and net Greeks

### 4. Futures
- Futures curve (term structure) chart per root symbol (ES, NQ, CL, GC, ZB, etc.)
- Contango/backwardation indicator, front-month roll date, days to expiry
- Continuous contract chart with back-adjustment option
- Contract specs panel: tick size, tick value, multiplier, margin estimate

### 5. Positions and P&L
- Manual entry or CSV import of positions (stocks, futures, options)
- Live unrealized and realized P&L, day P&L, cost basis, portfolio net Greeks
- Exposure breakdown by asset class and by underlying
- Futures P&L must use contract multipliers; options must use the 100x multiplier

### 6. Alerts
- Rules: price crosses, % move, volume spike, IV rank threshold, RSI threshold, option premium target
- Evaluated server-side on a worker or interval; delivered via in-app toast, browser push, and optional webhook (Discord/Slack/email)
- Alert history log

### 7. Market overview
- Index and futures strip (SPX, NDX, DJI, VIX, ES, NQ, CL, GC, DXY, 10Y)
- Top movers, most active, sector heatmap
- Market status indicator (pre-market, open, after-hours, closed) with correct handling of futures' near-24h sessions

## UX requirements
- Dark mode by default, with a light theme option
- Resizable, draggable panel layout (react-grid-layout or similar), persisted per user
- Keyboard shortcuts: / or Cmd+K for search, number keys to switch layouts, J/K to move through watchlist rows
- Tabular-nums monospace for all prices; consistent decimal precision per instrument
- Handle loading, stale-data, and disconnected states visibly (show a "stale" badge and last-update time)
- Fully responsive down to tablet; mobile gets a simplified watchlist and alerts view

## Performance
- Batch and throttle tick updates (render at most ~4-10 fps per row), and use `useSyncExternalStore` or a store with selectors to avoid re-rendering the whole table
- Virtualize long lists and the option chain (TanStack Virtual)
- Cache REST responses with sensible TTLs; dedupe subscriptions across components
- Reconnect with exponential backoff and resubscribe automatically

## Project structure
/app (routes: /, /watchlists, /chart/[symbol], /options/[underlying], /futures/[root], /positions, /alerts, /settings, /api/*)
/components, /lib/providers, /lib/greeks, /lib/indicators, /lib/stream, /db, /tests

## Deliverables
1. Working project that runs with `pnpm install && pnpm dev` using the mock provider
2. README covering setup, env vars, how to add a new provider, and architecture overview
3. Unit tests for Greeks, indicators, P&L math, and futures multiplier handling; one Playwright smoke test per main page
4. A short note listing known limitations

## Constraints and notes
- Never hardcode API keys; validate env vars at startup with Zod
- Label data clearly as real-time or delayed; most free tiers are delayed 15 minutes, and exchange data redistribution has licensing rules, so do not build anything that republishes data publicly
- Include a footer disclaimer: informational only, not financial advice
- Work in stages: scaffold and mock provider first, then watchlist and charts, then options, futures, positions, and alerts. Check in after each stage with what runs and what's next.