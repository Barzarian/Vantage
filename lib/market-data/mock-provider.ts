import {
  barSchema,
  futuresContractSchema,
  optionContractSchema,
  quoteSchema,
  type Bar,
  type FuturesContract,
  type InstrumentSearchResult,
  type OptionContract,
  type Quote,
  type Tick,
} from "./schemas";
import type { BarRange, MarketDataProvider, TickListener, Timeframe } from "./provider";
import type { BarListener } from "./provider";
import { BarAggregator } from "@/services/ibkr-bridge/src/bar-aggregator";

const SEEDS: Record<string, { name: string; type: Quote["type"]; price: number }> = {
  SPX: { name: "S&P 500", type: "index", price: 5824.5 },
  NDX: { name: "Nasdaq 100", type: "index", price: 20418.2 },
  DJI: { name: "Dow Jones", type: "index", price: 42631.8 },
  VIX: { name: "CBOE Volatility Index", type: "index", price: 18.42 },
  ES: { name: "E-mini S&P 500", type: "future", price: 5836.25 },
  NQ: { name: "E-mini Nasdaq 100", type: "future", price: 20465.5 },
  CL: { name: "Crude Oil", type: "future", price: 72.84 },
  GC: { name: "Gold", type: "future", price: 2678.3 },
  DXY: { name: "U.S. Dollar Index", type: "index", price: 103.72 },
  "10Y": { name: "10-Year Treasury Yield", type: "index", price: 4.18 },
  AAPL: { name: "Apple Inc.", type: "stock", price: 228.62 },
  NVDA: { name: "NVIDIA Corporation", type: "stock", price: 142.87 },
  MSFT: { name: "Microsoft Corporation", type: "stock", price: 421.34 },
  TSLA: { name: "Tesla, Inc.", type: "stock", price: 352.56 },
  AMZN: { name: "Amazon.com, Inc.", type: "stock", price: 221.48 },
  META: { name: "Meta Platforms, Inc.", type: "stock", price: 596.12 },
  "AAPL 250117C00230000": { name: "AAPL Jan 230 Call", type: "option", price: 8.45 },
};
const BASES: Record<string, number> = Object.fromEntries(
  Object.entries(SEEDS).map(([symbol, seed]) => [symbol, seed.price]),
);

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
  "1M": 2592000,
};

function priceFor(symbol: string): number {
  if (BASES[symbol]) return BASES[symbol];
  const seed = [...symbol].reduce((total, char) => total + char.charCodeAt(0), 0);
  return Math.max(1, (seed * 1.713) % 500 + 20);
}

function typeFor(symbol: string): Quote["type"] {
  return SEEDS[symbol]?.type ?? (symbol.includes(" ") ? "option" : "stock");
}

function makeQuote(symbol: string, previous?: number, previousVolume?: number): Quote {
  const baseline = priceFor(symbol);
  const prior = previous ?? baseline * (1 + (Math.random() - 0.5) * 0.025);
  const last = Math.max(0.01, prior * (1 + (Math.random() - 0.5) * 0.0008));
  const spread = Math.max(last * 0.00015, 0.01);
  const dayLow = Math.min(last, baseline * 0.992);
  const dayHigh = Math.max(last, baseline * 1.008);
  const lastSize = Math.floor(1 + Math.random() * 200);

  return quoteSchema.parse({
    symbol,
    name: SEEDS[symbol]?.name ?? symbol,
    type: typeFor(symbol),
    last,
    change: last - baseline,
    changePercent: ((last - baseline) / baseline) * 100,
    bid: last - spread / 2,
    ask: last + spread / 2,
    volume: previousVolume === undefined
      ? Math.floor(200_000 + Math.random() * 8_000_000)
      : previousVolume + lastSize,
    lastSize,
    dayLow,
    dayHigh,
    weekLow: baseline * 0.88,
    weekHigh: baseline * 1.12,
    updatedAt: new Date().toISOString(),
  });
}

export class MockMarketDataProvider implements MarketDataProvider {
  private readonly prices = new Map<string, number>();
  private readonly volumes = new Map<string, number>();

  async getQuote(symbols: string[]): Promise<Quote[]> {
    return symbols.map((symbol) => {
      const quote = makeQuote(symbol, this.prices.get(symbol), this.volumes.get(symbol));
      this.prices.set(symbol, quote.last);
      this.volumes.set(symbol, quote.volume);
      return quote;
    });
  }

  async searchSymbols(query: string): Promise<InstrumentSearchResult[]> {
    const normalized = query.trim().toUpperCase();
    return Object.entries(SEEDS)
      .filter(([symbol, seed]) => symbol.startsWith(normalized) || seed.name.toUpperCase().includes(normalized))
      .slice(0, 20)
      .map(([symbol, seed]) => ({
        conId: [...symbol].reduce((total, character) => total * 31 + character.charCodeAt(0), 0) >>> 0 || 1,
        symbol,
        name: seed.name,
        secType: seed.type === "future" ? "FUT" : seed.type === "index" ? "IND" : "STK",
        exchange: seed.type === "future" ? "CME" : seed.type === "index" ? "CBOE" : "SMART",
        primaryExchange: seed.type === "stock" ? "NASDAQ" : undefined,
        currency: "USD",
      }));
  }

  async getBars(symbol: string, timeframe: Timeframe, range: BarRange): Promise<Bar[]> {
    const interval = TIMEFRAME_SECONDS[timeframe];
    const count = Math.min(range.limit ?? 120, 500);
    const end = Math.floor(range.to / interval) * interval;
    let price = priceFor(symbol) * 0.97;
    const aggregator = new BarAggregator();

    for (let index = count - 1; index >= 0; index -= 1) {
      const time = end - index * interval;
      for (let sample = 0; sample < 4; sample += 1) {
        price = Math.max(0.01, price * (1 + (Math.random() - 0.49) * 0.002));
        aggregator.update(
          symbol,
          timeframe,
          time + Math.floor((interval * sample) / 4),
          price,
          Math.floor(250 + Math.random() * 6_000),
        );
      }
    }

    return aggregator
      .getBars(symbol, timeframe)
      .map((bar) => barSchema.parse(bar))
      .filter((bar) => bar.time >= range.from && bar.time <= range.to);
  }

  async getOptionChain(underlying: string, expiry?: string): Promise<OptionContract[]> {
    const rootPrice = priceFor(underlying);
    const expiration = expiry ?? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const center = Math.round(rootPrice / 5) * 5;
    const contracts: OptionContract[] = [];
    for (let offset = -10; offset <= 10; offset += 1) {
      for (const side of ["call", "put"] as const) {
        const strike = center + offset * 5;
        const intrinsic = side === "call" ? Math.max(rootPrice - strike, 0) : Math.max(strike - rootPrice, 0);
        const timeValue = Math.max(0.2, rootPrice * 0.018 * Math.exp(-Math.abs(offset) * 0.12));
        contracts.push(
          optionContractSchema.parse({
            symbol: `${underlying}${expiration.replaceAll("-", "").slice(2)}${side === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`,
            expiry: expiration,
            strike,
            side,
            bid: intrinsic + timeValue * 0.96,
            ask: intrinsic + timeValue * 1.04,
            last: intrinsic + timeValue,
            volume: Math.floor(Math.random() * 5000),
            openInterest: Math.floor(500 + Math.random() * 20000),
            impliedVolatility: 0.18 + Math.abs(offset) * 0.009 + Math.random() * 0.025,
          }),
        );
      }
    }
    return contracts;
  }

  async getFuturesCurve(root: string): Promise<FuturesContract[]> {
    const base = priceFor(root);
    return Array.from({ length: 8 }, (_, index) => {
      const expiryDate = new Date(Date.now() + (25 + index * 30) * 86400000);
      return futuresContractSchema.parse({
        symbol: `${root}${expiryDate.toISOString().slice(2, 7).replace("-", "")}`,
        expiry: expiryDate.toISOString().slice(0, 10),
        last: base * (1 + index * 0.0015 + (Math.random() - 0.5) * 0.0005),
        daysToExpiry: Math.ceil((expiryDate.getTime() - Date.now()) / 86400000),
      });
    });
  }

  subscribe(
    symbols: string[],
    onTick: TickListener,
    onBar?: BarListener,
    timeframe: Timeframe = "1m",
  ): () => void {
    const uniqueSymbols = [...new Set(symbols)];
    const aggregator = new BarAggregator();
    const timer = setInterval(() => {
      for (const symbol of uniqueSymbols) {
        const quote = makeQuote(symbol, this.prices.get(symbol), this.volumes.get(symbol));
        this.prices.set(symbol, quote.last);
        this.volumes.set(symbol, quote.volume);
        const tick: Tick = quote;
        onTick(tick);
        if (onBar) {
          const bar = aggregator.update(symbol, timeframe, Math.floor(Date.now() / 1000), quote.last);
          onBar(symbol, bar);
        }
      }
    }, 900);
    return () => clearInterval(timer);
  }
}
