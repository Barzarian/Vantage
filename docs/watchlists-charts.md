Build the Watchlists and Charts features for my Next.js market dashboard (App Router, TypeScript strict, Tailwind, shadcn/ui, TanStack Query, Zustand, Drizzle + Postgres, TradingView lightweight-charts).

If the project scaffold, `MarketDataProvider` interface, and mock provider don't exist yet, create them first, minimally:
- `getQuote(symbols)`, `getBars(symbol, timeframe, range)`, `subscribe(symbols, onTick)`
- A mock provider using seeded random-walk data that produces realistic OHLCV bars and ticks, so everything runs with no API keys

Do not touch options, futures, positions, or alerts in this stage.

## Part 1: Streaming layer (build first, both features depend on it)
- A single tick store (Zustand or an external store read with `useSyncExternalStore`) keyed by symbol, with per-symbol selectors so one tick re-renders only the rows and charts that use it
- Server-side relay over SSE (or WS) so vendor credentials never reach the browser
- Dedupe subscriptions: ref-count symbols across components, subscribe on first use, unsubscribe on last unmount
- Batch ticks and flush to the store at most every 100-250ms
- Connection state (connected, reconnecting, stale, disconnected) exposed via a hook, with exponential backoff reconnect and automatic resubscribe
- Each quote carries `lastUpdate`; mark a symbol "stale" if no tick arrives within a configurable window during market hours

## Part 2: Watchlists

### Data and persistence
- Drizzle tables: `watchlists` (id, userId, name, position) and `watchlist_items` (id, watchlistId, symbol, assetClass, position, notes)
- CRUD route handlers or server actions validated with Zod: create, rename, delete, duplicate watchlists; add, remove, reorder items
- Optimistic updates through TanStack Query with rollback on failure
- Seed a default "Watchlist 1" with ~15 symbols (mix of equities and ETFs like AAPL, MSFT, NVDA, SPY, QQQ, IWM, TSLA, AMD, META, AMZN, GOOGL, JPM, XOM, GLD, TLT)

### UI
- Tabbed or sidebar list of watchlists, with a "+" to create
- Table columns: symbol, name, last, change, % change, bid, ask, volume, day range (mini bar), 52-week range (mini bar), sparkline (last ~60 points)
- Green/red flash on price change (CSS transition, respects `prefers-reduced-motion`)
- Tabular-nums monospace for numbers; right-aligned; correct decimal precision per instrument
- Sort by any column; column visibility picker; persist column settings per user
- Drag-and-drop row reordering (dnd-kit), persisted
- Virtualized rows (TanStack Virtual) so 500+ symbols stay smooth
- Row actions: open chart, remove, move to another list
- Selected row highlight; clicking a row sets the "active symbol" that charts follow
- Symbol search via Cmd+K / "/" command palette (shadcn Command) with debounced autocomplete, Enter to add to the active watchlist
- Keyboard: J/K to move selection, Enter to open chart, Delete to remove, with a visible shortcut hint
- Empty, loading (skeleton), and error states

## Part 3: Charts

### Core chart
- lightweight-charts wrapped in a reusable `<PriceChart symbol timeframe />` client component with proper create/destroy on mount and unmount and a ResizeObserver
- Chart types: candlestick, line, area, with a toggle
- Timeframes: 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M, with a range selector (1D, 5D, 1M, 3M, 6M, 1Y, 5Y, Max)
- Initial history via `getBars` (TanStack Query, cached by symbol and timeframe), then live updates by updating the last bar from ticks and rolling to a new bar when the period boundary passes
- Lazy-load older history when the user scrolls left
- Volume histogram in a sub-pane; crosshair with an OHLCV legend that follows the cursor
- Price scale: normal, log, and percent modes; last-price line and label
- Handle timezones correctly (display in exchange time or local time via a setting) and handle gaps for sessions that are closed

### Indicators (pure functions in /lib/indicators, unit tested)
- Overlays: SMA, EMA, VWAP, Bollinger Bands
- Sub-panes: RSI, MACD
- Indicator menu to add, configure (periods), and remove; settings persisted per user
- Compute incrementally on new ticks where practical rather than recomputing the whole series every update

### Multi-chart layout
- Layouts: 1, 2 (side by side), and 4 (2x2) panes
- Each pane has its own symbol and timeframe, with the option to link to the watchlist's active symbol
- Synced crosshair and optionally synced time scale across panes
- Compare/overlay: add a second symbol normalized to percent change
- Persist layout, pane symbols, and indicators per user (Drizzle table `saved_layouts` with JSON config validated by Zod)

### Route
- `/chart/[symbol]` full-page chart, and a combined `/watchlists` view with the list on the left and a chart panel on the right (resizable split)

## Quality bar
- Dark theme by default; chart colors read from CSS variables so the light theme works
- No full-table re-renders on a tick (verify with React Profiler and report what you found)
- No memory leaks: charts and subscriptions are cleaned up on unmount
- Clear stale and disconnected badges with a last-update time
- Never expose provider keys to the client; validate env with Zod

## Tests
- Vitest: indicator math (SMA, EMA, VWAP, RSI, MACD, Bollinger) against known fixtures, bar-aggregation logic (tick to bar rollover), subscription ref-counting, and store batching
- Playwright smoke tests: create a watchlist, add a symbol through search, reorder rows, open a chart, switch timeframe, add an indicator, and reload to confirm persistence

## Working method
Build in this order, running and verifying after each step, and summarize what works at the end of each:
1. Streaming layer and tick store
2. Watchlist persistence and API
3. Watchlist table UI with live updates
4. Single chart with live updates
5. Indicators
6. Multi-chart layouts, compare, and persistence
7. Tests and a short list of known limitations