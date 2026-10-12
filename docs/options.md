Build the Options feature for my Next.js market dashboard (App Router, TypeScript strict, Tailwind, shadcn/ui, TanStack Query, TanStack Virtual, Zustand, Recharts, Drizzle + Postgres, Zod).

Assume the streaming layer, tick store, `MarketDataProvider` interface, and mock provider from the previous stage exist. Extend them rather than replacing them. Do not touch futures, positions, or alerts in this stage.

## Part 1: Data layer extensions

### Types (Zod-validated at the provider boundary)
- `OptionContract`: occSymbol, underlying, expiry (ISO date), strike, type (call|put), multiplier (default 100), style (american|european)
- `OptionQuote`: bid, ask, last, mark (mid), volume, openInterest, iv, delta, gamma, theta, vega, rho, lastUpdate, greeksSource ("provider" | "computed")
- `OptionChain`: underlying, underlyingPrice, asOf, expiries[], contracts grouped by expiry then strike, with call and put paired per strike

### Provider interface additions
- `getOptionExpiries(underlying)`
- `getOptionChain(underlying, expiry)`
- `subscribeOptions(occSymbols, onTick)`, which reuses the same ref-counted, batched subscription manager as equities
- Utilities: parse and format OCC symbols (e.g. AAPL261218C00250000), with unit tests including edge cases (fractional strikes, 1-letter and 6-letter roots)

### Mock provider
- Generate realistic chains: weekly and monthly expiries out ~2 years, strikes spaced sensibly by underlying price, a volatility smile and term structure, bid/ask spreads that widen away from the money, plausible volume and open interest
- Option prices must be derived from Black-Scholes using the mock underlying price, so they move consistently when the underlying ticks
- Seeded and deterministic for tests

## Part 2: Pricing and Greeks (/lib/greeks, pure functions, heavily unit tested)
- Black-Scholes-Merton with continuous dividend yield: price, delta, gamma, theta (per calendar day), vega (per 1 vol point), rho (per 1 rate point)
- Implied volatility solver: Newton-Raphson with a bisection fallback, bounds [0.001, 5], max iterations, and a clear "no solution" result for prices below intrinsic or above the theoretical max
- Use mid price for IV; fall back to last if there is no valid bid/ask; flag stale or crossed quotes
- Time to expiry in years using actual/365 with expiry at 16:00 America/New_York; handle same-day expiry without division by zero
- Configurable risk-free rate and dividend yield (settings, with defaults)
- Document the limitation: American-style equity options are priced with a European model, which is an approximation (acceptable for display; note early-exercise error for deep ITM puts and dividend-paying names)
- Use provider Greeks when present; compute only when missing; label the source in the UI
- Tests: known reference values for several (S, K, T, r, q, sigma) cases, put-call parity, IV round-trip (price then solve then recover sigma within tolerance), and edge cases (T near 0, deep ITM and OTM, very low vol)

## Part 3: Options chain UI

### Route
`/options/[underlying]` with the underlying symbol in a header showing last price, change, and the same stale and connection badges used elsewhere

### Chain table
- Calls on the left, strikes in the center, puts on the right
- Columns per side: bid, ask, last, mark, change, volume, OI, IV, delta, gamma, theta, vega
- Column visibility picker, persisted per user
- Auto-scroll to center the at-the-money strike on load, with a "Jump to ATM" button; highlight the ATM row, shade ITM cells distinctly, and show a divider line at the underlying price
- Expiry selector as tabs or chips with days-to-expiry, grouped by month, with weeklies distinguished
- Strike range control (±N strikes around ATM, or "All")
- Filters: min volume, min OI, delta range, max bid/ask spread %, calls only, puts only
- Virtualized rows (TanStack Virtual); only subscribe to option symbols currently visible plus a small buffer, and unsubscribe as rows scroll away, to respect provider subscription limits
- Tick flash on bid/ask/last changes (respect `prefers-reduced-motion`), tabular-nums, consistent 2-decimal precision
- Clicking a bid or ask adds that leg to the strategy builder (click bid to sell, click ask to buy); shift-click to add a quantity of 10
- Show an unusual-activity marker when volume exceeds OI

### Summary strip
Underlying price, IV rank and IV percentile (computed from stored history if available; otherwise show "n/a" and explain why), ATM IV for the selected expiry, put/call volume ratio, put/call OI ratio, and expected move (ATM straddle mid / underlying)

## Part 4: Volatility charts (Recharts)
- IV skew (smile): IV vs strike for the selected expiry, calls and puts overlaid, with a marker at the underlying price; toggle x-axis between strike, moneyness, and delta
- IV term structure: ATM IV vs expiry date, with the ability to overlay a second date's snapshot if history exists
- Open interest and volume by strike (bar chart) with the underlying price line
- Charts update when the chain updates, throttled to ~1/sec

## Part 5: Strategy builder

### Model
- A strategy is a list of legs: instrument (option contract or underlying shares), side (long|short), quantity, entry price (default mark, editable)
- Presets that fill legs automatically for the selected expiry and strikes near ATM: long call, long put, covered call, cash-secured put, vertical call/put spreads, straddle, strangle, iron condor, iron butterfly, calendar, custom
- Legs can be added from the chain, edited inline, and removed

### Analytics (pure functions, unit tested)
- Payoff at expiry across a price range (default ±30% of spot, adjustable)
- Theoretical P&L curve at T+n days using Black-Scholes, with a slider for days forward and an IV shift control (e.g. -10 to +10 vol points)
- Net debit/credit, max profit, max loss (flag "unlimited" correctly for naked calls and short straddles), breakeven prices, and approximate probability of profit from the lognormal distribution at the selected IV
- Net Greeks: aggregate delta, gamma, theta, vega, scaled by quantity and the 100x multiplier
- Estimated margin or buying power: show a simple approximation only, and label it as an estimate

### UI
- Side panel or drawer listing legs, with totals at the bottom
- Payoff diagram (Recharts): expiry curve, T+n curve, zero line, breakeven markers, current spot marker, profit region green, loss region red, and a hover tooltip showing price and P&L
- Save and load strategies (Drizzle table `saved_strategies`: id, userId, name, underlying, legs JSON validated by Zod), with an option to "refresh prices" using current marks

## Part 6: Integration
- Add an "Options" link from watchlist rows and the chart page header that opens `/options/[symbol]`
- Reuse the shared tick store for the underlying price so the chain's ATM highlight and the strategy P&L update live
- Persist chain preferences (visible columns, filters, strike range, last selected expiry per underlying) per user

## Quality bar
- Chain with 500+ rows stays smooth while ticking (verify with React Profiler and report findings)
- No re-render of the whole chain on a single option tick; per-contract selectors only
- All money math uses the 100x multiplier; no floating-point display artifacts (format at the edge)
- Clear UI for missing data (dashes, not zero), crossed markets, and zero-bid contracts
- Never expose provider keys to the client; validate env with Zod
- Footer note: options involve risk; theoretical values are estimates; informational only, not financial advice

## Tests
- Vitest: OCC parsing, Black-Scholes and Greeks fixtures, IV solver round-trip, payoff and breakeven math for each preset strategy, max profit/loss including unlimited cases, net Greeks aggregation
- Playwright: open /options/SPY, switch expiry, apply a delta filter, click an ask and a bid to build a vertical spread, verify the payoff diagram shows two breakevens or one as appropriate, save the strategy, reload, and confirm it persists

## Working method
Build in this order, running and verifying after each step, and summarize what works at the end of each:
1. Types, OCC utilities, and mock chain generator
2. Greeks and IV library with tests
3. Chain API route and TanStack Query hooks
4. Chain table UI with filters and virtualization
5. Live option subscriptions scoped to visible rows
6. Skew, term structure, and OI charts
7. Strategy builder, payoff diagram, and persistence
8. Tests and a short list of known limitations