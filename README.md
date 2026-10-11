# Vantage Market Terminal

A single-user-first market monitoring dashboard for stocks, futures, and options. The interface is dark by default and designed for dense market data. The included mock provider needs no market-data API keys and is the default.

> **Data disclaimer:** Mock quotes are simulated and are not real-time exchange data. This application is for informational purposes only, not financial advice. Before connecting a real data source, confirm the provider's delay, exchange entitlements, and redistribution terms. Do not expose market data publicly without the necessary licenses.

## Run locally

Requirements: Node.js 22 or newer, Corepack, and Docker Compose when using `pnpm dev:all`.

```sh
corepack enable
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). No environment file or API key is needed for mock mode. Copy `.env.example` to `.env.local` only when configuring optional services.

Mock mode:

```sh
pnpm dev
```

IBKR mode (starts the local Postgres cache, Next.js, and bridge processes):

```sh
cp .env.example .env.local
# Set MARKET_DATA_PROVIDER=ibkr and replace IBKR_BRIDGE_TOKEN with a random secret.
pnpm dev:all
```

The bridge stays bound to `127.0.0.1`; the Next.js server authenticates to it using `IBKR_BRIDGE_TOKEN`. Keep the same secret in the Next app and bridge environment. `pnpm dev:all` starts only Postgres and the two Node processes; IB Gateway/TWS must already be running separately.

Useful commands:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
```

The unit suite covers Black-Scholes Greeks, SMA/EMA/RSI/MACD/Bollinger Bands/VWAP, realized and unrealized P&L, contract multipliers, and watchlist/chart utilities. Playwright workflows live in `tests/e2e` and exercise the overview, watchlist, chart, and saved chart controls.

## Configuration

| Variable | Description |
| --- | --- |
| `MARKET_DATA_PROVIDER` | `mock` or `ibkr`; defaults to `mock`. |
| `IB_HOST` | IB Gateway/TWS host. Defaults to `127.0.0.1`; the bridge itself must bind only to localhost. |
| `IB_PORT` | Paper Gateway `4002`, live Gateway `4001`, paper TWS `7497`, live TWS `7496`. |
| `IB_CLIENT_ID` | Unique integer per API connection. Do not reuse an ID already connected to the same Gateway. |
| `IB_MARKET_DATA_TYPE` | `1` live, `2` frozen, `3` delayed, `4` delayed-frozen. Defaults to `3`. |
| `IB_READ_ONLY` | Must remain `true`; the bridge rejects `false` and has no order-placement API. Also enable Read-Only API in Gateway settings. |
| `IB_USE_RTH_EQUITIES` | Use regular trading hours for equity history; defaults to `true`. Futures default to all sessions (`useRTH=false`). |
| `IB_MARKET_DATA_LINE_LIMIT` | Local cap for simultaneous `reqMktData` subscriptions; defaults to 100. |
| `IB_MARKET_DATA_LRU_EVICT` | Opt-in eviction of least-recently-updated subscriptions explicitly marked evictable. Defaults to `false`. |
| `IBKR_BRIDGE_HOST` / `IBKR_BRIDGE_PORT` | Bridge listen address/port. The listen host is restricted to localhost; port defaults to `8787`. |
| `IBKR_BRIDGE_URL` | Private server-side URL used by Next.js; defaults to `http://127.0.0.1:8787`. |
| `IBKR_BRIDGE_TOKEN` | Shared secret (minimum 32 characters) sent only as a server-to-server header. Generate a unique secret; never expose it with a `NEXT_PUBLIC_` prefix. |
| `DATABASE_URL` | Postgres URL for persistent `ib_contracts` and `ib_historical_cache` tables. Required to start the bridge. `pnpm dev:all` starts local Postgres on port 5433. |
| `AUTH_SECRET` | Reserved for the planned Auth.js setup. |

The Next app parses its provider configuration with Zod in `lib/market-data/env.ts`; the bridge validates its own config before starting in `services/ibkr-bridge/src/config.ts`. IBKR connection details, the shared secret, and Postgres credentials stay server-side.

## Architecture

- `app/` contains the Next.js App Router entry point and server route handlers.
- `components/` contains interactive client UI.
- `lib/market-data/provider.ts` defines the provider-agnostic `MarketDataProvider` interface.
- `lib/market-data/mock-provider.ts` supplies deterministic symbol metadata and simulated random-walk quotes, bars, option chains, and futures curves.
- `lib/providers/ibkr-provider.ts` is the Next.js adapter. It calls only the private bridge and validates bridge responses with Zod.
- `services/ibkr-bridge` is a separate Node process using `@stoqey/ib`; it owns the persistent TWS socket, conId contract resolver, market-data accumulator, line/ref-count manager, historical request queue, and server-side SSE.
- `app/api/quotes`, `app/api/search`, and `app/api/stream` proxy through Next.js. The browser never receives the bridge URL/token or speaks directly to IB Gateway.
- `/watchlists` and `/chart/[symbol]` provide a live watchlist and chart workspace. `/api/watchlists`, `/api/bars`, and `/api/preferences` validate requests and persist data when Postgres is configured.
- `lib/market-data/quote-store.ts` stores normalized quote snapshots by symbol; symbol-specific subscriptions mean a tick notifies only consumers of that symbol.
- `lib/market-data/stream-manager.ts` shares the browser's SSE stream, ref-counts symbols, buffers quote ticks and flushes them every 150 ms, then reconnects with exponential backoff and jitter. The store tracks last update and marks quotes stale after a quiet period. The watchlist requests quotes and subscribes to the stream once for the union of its symbols.
- Chart panels lazily load `lightweight-charts` on the client, fetch history through `/api/bars`, and apply streamed ticks to timeframe bars. Chart controls and watchlist columns are saved locally and sent to the preferences API.
- Contract metadata and historical responses are cached in Postgres (`ib_contracts`, `ib_historical_cache`). Without Postgres the bridge does not start; mock mode does not use the bridge.
- `services/ibkr-bridge/src/bar-aggregator.ts` is shared by live IBKR ticks and the mock provider so chart OHLCV aggregation follows the same path.
- Zod schemas in `lib/market-data/schemas.ts` validate data at the provider/API boundary.
- Tailwind CSS is used for the terminal UI; shared class merging lives in `lib/utils.ts`.

### Adding a market-data provider

1. Implement `MarketDataProvider` in `lib/providers/` and validate responses with the existing Zod schemas.
2. Validate server-only configuration in `lib/market-data/env.ts`.
3. Select the adapter in `lib/market-data/index.ts`; keep browser calls routed through `/api/*`.
4. Fan streaming through server-side SSE and preserve unsubscribe/reconnect behavior. Never put provider keys in client code.
5. Label data as real-time or delayed according to the provider's actual entitlement.

### Watchlists and charts

The watchlist API supports multiple named lists, duplicate/rename/delete, item add/edit/move/remove, and validated reorder. It uses the Drizzle schema and `db/migrations/0001_watchlists.sql` when `DATABASE_URL` is configured, and a process-local in-memory store in mock mode without Postgres. The seed creates Core and Macro sample lists. Chart pane/layout preferences and watchlist columns use `/api/preferences`; a local browser copy keeps the demo usable without a database.

The stream manager owns a single browser SSE connection for each active symbol set and coalesces incoming quote fields into the symbol-keyed quote store at a maximum update rate of about 6.7 Hz. Components subscribe to individual quote symbols rather than the entire table. Connection state, last update, delayed/frozen source, and stale data are visible in the UI. The stale threshold defaults to 15 seconds and can be set when constructing `MarketStreamManager`. Quote updates are symbol-scoped in the store test; a React Profiler session has not been run.

To add an indicator, implement its pure calculation in `lib/indicators`, add its validated kind/configuration to `lib/watchlists/preferences.ts`, then connect it to the chart's indicator selector and rendering path in `components/price-chart-panel.tsx`. Keep calculations independent of React and add known-value unit tests.

Known watchlist/chart limitations: this is still single-user-first (`local-user` is a placeholder; Auth.js is not wired), so database records are not isolated by authenticated identity. The no-Postgres fallback is process-local and not durable across server restarts. Chart range/history availability depends on the selected provider and is subject to IBKR pacing; lazy history and live bars have not been validated against all exchange sessions, especially overnight futures. Chart crosshair/time synchronization is approximate across dissimilar trading calendars. The desktop split is simplified on small screens, and symbol search currently uses the provider's available directory rather than exchange-wide discovery in mock mode.

## Interactive Brokers setup

The bridge uses the TWS socket API; it does not use Client Portal Gateway and does not place orders.

1. Install and log in to IB Gateway or TWS. Use the **paper** session first.
2. In **Global Configuration → API → Settings**, enable socket clients, set the socket port to the value of `IB_PORT`, enable **Read-Only API**, and add `127.0.0.1` to trusted IPs. Do not bind or firewall-forward the Gateway or bridge to the public internet.
3. Set `IB_HOST`, `IB_PORT=4002` for paper Gateway (`7497` for paper TWS), a unique `IB_CLIENT_ID`, and `IB_MARKET_DATA_TYPE=3` for delayed data. Set a strong matching bridge secret and `DATABASE_URL`.
4. Run `pnpm dev:all`. Check authenticated bridge health at `http://127.0.0.1:8787/health` from a trusted local client using the `x-ibkr-bridge-token` header. The dashboard exposes market status and actionable subscription/connectivity errors.
5. For live Gateway/TWS, configure `IB_PORT=4001` or `7496` only after confirming the paper workflow. Use the relevant funded account and market-data entitlements.

IBKR commonly limits accounts to around 100 simultaneous market-data lines, but the actual cap depends on account entitlements. The bridge enforces `IB_MARKET_DATA_LINE_LIMIT`, shares each active conId subscription among clients, and returns a visible line-limit error. Optional LRU eviction is disabled by default and only considers subscriptions explicitly marked evictable. Historical pacing is conservative: the bridge enforces 6 requests per 2 seconds, 60 per rolling 10 minutes, 15 seconds between identical requests, and chunks requests to valid bar-size/duration pairs.

### Paper-account manual checklist

- [ ] Verify the paper Gateway API port, socket-client setting, Read-Only API, and trusted localhost address.
- [ ] Start `pnpm dev:all` with `IB_PORT=4002`, a unique `IB_CLIENT_ID`, valid Postgres URL, and a generated shared secret.
- [ ] Check `/health`: state should move from `connecting` to `live`; market-data type and active line count should be visible.
- [ ] Search a symbol with multiple listings and verify each result shows exchange/currency before selecting a `conId`.
- [ ] Test quote and historical bars for an equity and a futures contract, including extended hours and `useRTH` behavior.
- [ ] Use `IB_MARKET_DATA_TYPE=3` to verify delayed tick mapping and the visible **DELAYED** label.
- [ ] Temporarily disconnect Gateway and verify the dashboard reports reconnecting, then returns to live and resubscribes.
- [ ] Request more lines than the configured cap and verify a clear line-limit response; test LRU only with explicit evictable subscriptions.
- [ ] Log out of the paper API session before using the same IBKR username in TWS/mobile elsewhere.

IBKR's single-session rule can disconnect the API if the same username logs in from another TWS/mobile session. The bridge reports client/session errors distinctly; use a separate secondary username for API use where IBKR account configuration permits it. Enable Gateway auto-restart and plan for nightly/weekly resets; the bridge reconnects with exponential backoff and jitter.

Real-time quotes require the relevant IBKR market-data subscriptions and a funded account. `IB_MARKET_DATA_TYPE=3` requests delayed data when available; delayed availability and delay length vary by instrument and entitlement. IBKR market data is for personal, non-professional use under the account data agreement. Do not redistribute it publicly.

## Current stage and known limitations

The overview supports mock data by default and a private IBKR bridge for stock, index, and futures quotes/bars. Core unit-tested calculations are provided for Black-Scholes Greeks, technical indicators, and position P&L; they are not yet wired into full options or portfolio pages.

Limitations: IBKR options and order placement are intentionally not implemented. Futures roots with ambiguous expiries/listings must be resolved to a displayed contract; continuous/back-adjusted futures are not provided. IBKR historical response caching is range-keyed, not a full local bar warehouse; very large history loads are slow by design due to pacing. Reconnect gap recovery applies to active live-bar subscriptions. No user authentication, portfolio persistence, alert delivery, or market-data licensing enforcement is included. The mock feed and illustrative market-status label are not exchange data. The current UI is desktop-first. Do not use this prototype to make trading decisions.
