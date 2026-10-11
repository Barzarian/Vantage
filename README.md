# Vantage Market Terminal

A single-user-first market monitoring dashboard for stocks, futures, and options. The interface is dark by default and designed for dense market data. The included mock provider needs no API keys and is the default.

> **Data disclaimer:** Mock quotes are simulated and are not real-time exchange data. This application is for informational purposes only, not financial advice. Before connecting a real data source, confirm the provider's delay, exchange entitlements, and redistribution terms. Do not expose market data publicly without the necessary licenses.

## Run locally

Requirements: Node.js 20.9 or newer and Corepack.

```sh
corepack enable
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). No environment file or API key is needed for mock mode. Copy `.env.example` to `.env.local` only when configuring optional services.

Useful commands:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
```

## Configuration

| Variable | Description |
| --- | --- |
| `MARKET_DATA_PROVIDER` | `mock` by default. `alpaca` is reserved until its adapter is implemented. |
| `ALPACA_API_KEY` / `ALPACA_API_SECRET` | Server-only credentials for the planned Alpaca adapter. Never use a `NEXT_PUBLIC_` prefix. |
| `ALPACA_DATA_URL` | Optional provider endpoint; defaults to Alpaca's market data URL. |
| `DATABASE_URL` | Reserved for the planned Postgres/Drizzle persistence layer. |
| `AUTH_SECRET` | Reserved for the planned Auth.js setup. |

The server parses provider configuration with Zod in `lib/market-data/env.ts`. Provider credentials belong only in server environment variables and must only be used by server-side adapters and route handlers.

## Architecture

- `app/` contains the Next.js App Router entry point and server route handlers.
- `components/` contains interactive client UI.
- `lib/market-data/provider.ts` defines the provider-agnostic `MarketDataProvider` interface.
- `lib/market-data/mock-provider.ts` supplies deterministic symbol metadata and simulated random-walk quotes, bars, option chains, and futures curves.
- `app/api/quotes` proxies quote requests through the server. `app/api/stream` fans validated mock ticks out to browsers with Server-Sent Events; vendor credentials are not sent to the client.
- Zod schemas in `lib/market-data/schemas.ts` validate data at the provider/API boundary.
- Tailwind CSS is used for the terminal UI; shared class merging lives in `lib/utils.ts`.

### Adding a market-data provider

1. Implement `MarketDataProvider` in `lib/market-data/` and validate provider responses with the existing Zod schemas before returning them.
2. Read API credentials from server-only variables validated in `lib/market-data/env.ts`.
3. Select the adapter in `lib/market-data/index.ts`; keep browser calls routed through `/api/*`.
4. For streaming, adapt the provider's server-side subscription to the SSE route and preserve unsubscribe/reconnect behavior. Do not place vendor keys in client code.
5. Label data as real-time or delayed according to the provider's actual entitlement.

## Current stage and known limitations

The scaffold and mock-provider stage is implemented. The overview shows simulated quotes and streams them through the server. The watchlist, charting, options, futures, positions, alerts, persistence, authentication, and real-provider adapter are staged for subsequent implementation.

The mock feed is generated locally and is not exchange data; its market-status display and example instrument metadata are illustrative only. No data is persisted, there is no authentication or alert delivery, and the current interface is desktop-first. Do not use mock values or this prototype to make trading decisions.
