Add a Futures feature to my existing Next.js market dashboard (App Router, TypeScript strict, Tailwind, shadcn/ui, TanStack Query, TanStack Virtual, Zustand, Recharts, lightweight-charts, Drizzle + Postgres, Zod). Extend the existing streaming layer, tick store, `MarketDataProvider` interface, and mock provider. Don't touch positions or alerts.

## 1. Data
- Zod types: FutureContract (root, symbol, month code, year, expiry, lastTradeDate, exchange), FutureQuote (bid, ask, last, settle, prevSettle, change, volume, openInterest, lastUpdate), ContractSpec (root, name, exchange, tickSize, tickValue, multiplier, currency, tradingHours, settlementType "cash" | "physical", margin estimate)
- Provider additions: `getFuturesCurve(root)`, `getFuturesContracts(root)`, `getContinuousBars(root, timeframe, range, adjustment)`, and `subscribe` support for futures symbols through the existing ref-counted, batched subscription manager
- Static contract spec table for: ES, NQ, YM, RTY, CL, NG, GC, SI, HG, ZB, ZN, ZC, ZS, ZW, 6E, VX
- Month code utilities (F G H J K M N Q U V X Z): parse and format symbols like ESZ6 and ESZ26, with unit tests including year rollover and decade ambiguity
- Mock provider: seeded, deterministic curves that can be in contango or backwardation, plausible volume and open interest declining toward expiry, and prices that move together across contracts when the front month ticks

## 2. Contract logic (/lib/futures, pure functions, unit tested)
- Expiry calendar rules per root (e.g. equity index: third Friday of the quarterly months; CL: three business days before the 25th; metals and grains per exchange rules); where rules are complex, use a data table and document the source
- Front-month detection and roll date, using either a calendar rule or a volume/open-interest crossover (configurable)
- Days to expiry, and a "rolling soon" flag within N days
- Calendar spread calculation (back minus front), annualized roll yield, and a contango/backwardation classifier (based on the front-to-second spread and the full curve slope)
- P&L math helpers: ticks moved, dollar value per tick, and notional value (price x multiplier)
- Back-adjustment for continuous contracts: ratio and difference (Panama) methods, applied at each roll date, with tests on small fixtures

## 3. Futures page UI at /futures/[root]
- Header: root name, front-month price, change, % change, session status, and the stale and connection badges used elsewhere
- Contract specs panel: tick size, tick value, multiplier, exchange, trading hours, settlement type, margin estimate (labeled as an estimate)
- Contracts table (virtualized if long): month, symbol, last, change, bid, ask, volume, OI, settle, days to expiry, and spread to front; highlight the front month and flag the roll window
- Term structure chart (Recharts): price vs expiry for all listed contracts, with an overlay of a prior snapshot (previous close, 1 week ago, 1 month ago) if history exists; show a contango/backwardation badge
- Calendar spread chart: selectable pair of contracts, spread over time
- Continuous contract chart (lightweight-charts): unadjusted, ratio-adjusted, or difference-adjusted toggle, roll dates marked on the time axis, and the same indicator and multi-timeframe controls as the equity charts
- Tick flash, tabular-nums, and correct decimal precision per product (e.g. ZB in 32nds, with a display toggle for decimal vs fractional; CL at 2 decimals; 6E at 5)

## 4. Futures overview at /futures
- Grid of root cards grouped by asset class (indices, energy, metals, rates, grains, FX): front price, % change, curve shape badge, and a sparkline
- Add futures to existing watchlists; the symbol search should recognize roots and specific contracts (ES, ESZ6), and a root should resolve to the continuous front-month contract

## 5. Sessions
- Model near-24h sessions per product with the daily maintenance break and Sunday open, in America/Chicago and America/New_York as appropriate
- Session status indicator (open, closed, maintenance break, pre-open) and a trading-day boundary for the daily change calculation based on the settlement time, not midnight
- Holiday and early-close handling through a small configurable calendar

## 6. Quality and tests
- No re-render of the full table on a single tick; per-contract selectors only
- Subscribe only to the contracts visible plus the front few, and unsubscribe on unmount
- Clear states for missing data (dashes), expired contracts, and illiquid back months
- Keys stay server-side; env validated with Zod
- Footer: futures involve substantial risk of loss; margin and values are estimates; informational only, not financial advice; data may be delayed
- Vitest: month code parsing, expiry rules, front-month and roll logic, curve classification, tick and dollar math with multipliers, back-adjustment on fixtures, session boundaries
- Playwright: open /futures/ES, verify the contract table and curve chart render, toggle adjustment method, switch fractional/decimal display on /futures/ZB, add ES to a watchlist and confirm it ticks

## Order of work
Verify after each step and summarize what works:
1. Types, specs table, and month code utilities
2. Contract logic library with tests
3. Mock curves and provider extensions
4. Contracts table and specs panel
5. Term structure and calendar spread charts
6. Continuous chart with back-adjustment
7. Overview page, search, and watchlist integration
8. Sessions, tests, and known limitations