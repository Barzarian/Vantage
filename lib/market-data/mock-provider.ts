import {
  barSchema,
  futuresContractSchema,
  optionChainItemSchema,
  optionContractSchema,
  optionQuoteSchema,
  quoteSchema,
  type Bar,
  type FuturesContract,
  type InstrumentSearchResult,
  type OptionChainItem,
  type Quote,
  type Tick,
} from "./schemas";
import type { BarRange, MarketDataProvider, TickListener, Timeframe } from "./provider";
import type { BarListener } from "./provider";
import { BarAggregator } from "@/services/ibkr-bridge/src/bar-aggregator";
import { calculateBlackScholes } from "@/lib/greeks/black-scholes";
import { optionExpiryTimestamp } from "@/lib/greeks/expiry";
import { formatOccSymbol, parseOccSymbol } from "@/lib/greeks/occ";
import type { OptionTickListener } from "./provider";

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
  SPY: { name: "SPDR S&P 500 ETF Trust", type: "stock", price: 573.42 },
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
  private readonly optionVolumes = new Map<string, number>();

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

  async getOptionExpiries(underlying: string): Promise<string[]> {
    const root = underlying.trim().toUpperCase();
    if (!SEEDS[root] || SEEDS[root]!.type === "future") {
      throw new RangeError(`Options are not available for ${root || "the requested underlying"}.`);
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const expiries = new Set<string>();
    for (let week = 0; week <= 12; week += 1) {
      const friday = new Date(today);
      friday.setUTCDate(today.getUTCDate() + ((5 - today.getUTCDay() + 7) % 7 || 7) + week * 7);
      expiries.add(friday.toISOString().slice(0, 10));
    }
    for (let month = 0; month <= 5; month += 1) {
      const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + month, 1));
      const thirdFriday = new Date(first);
      thirdFriday.setUTCDate(1 + ((5 - first.getUTCDay() + 7) % 7) + 14);
      if (thirdFriday > today) expiries.add(thirdFriday.toISOString().slice(0, 10));
    }
    return [...expiries].sort();
  }

  async getOptionChain(underlying: string, expiry: string): Promise<OptionChainItem[]> {
    const root = underlying.trim().toUpperCase();
    if (!(await this.getOptionExpiries(root)).includes(expiry)) {
      throw new RangeError(`Unsupported option expiry ${expiry} for ${root}.`);
    }
    const spot = this.prices.get(root) ?? priceFor(root);
    const rootStep = spot >= 400 ? 10 : spot >= 100 ? 5 : spot >= 20 ? 1 : 0.5;
    const center = Math.round(spot / rootStep) * rootStep;
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const expiryInstant = optionExpiryTimestamp(expiry) * 1000;
    const timeToExpiry = Math.max(1 / 365, (expiryInstant - startOfToday.getTime()) / (365 * 86400000));
    const riskFreeRate = 0.045;
    const result: OptionChainItem[] = [];
    for (let offset = -24; offset <= 24; offset += 1) {
      const strike = Number((center + offset * rootStep).toFixed(3));
      if (strike <= 0) continue;
      for (const type of ["call", "put"] as const) {
        const contract = {
          underlying: root,
          expiry,
          strike,
          type,
          multiplier: 100 as const,
        };
        const occSymbol = formatOccSymbol(contract);
        const moneyness = Math.abs(Math.log(strike / spot));
        const iv = 0.17 + moneyness * 0.85 + 0.015 * Math.sqrt(timeToExpiry) +
          stableFraction(`${root}:${expiry}:${strike}:${type}`) * 0.012;
        const model = calculateBlackScholes({
          type,
          spot,
          strike,
          timeToExpiry,
          riskFreeRate,
          volatility: iv,
          dividendYield: root === "SPY" ? 0.012 : 0,
        });
        const width = Math.max(0.01, model.price * (0.012 + Math.min(0.08, moneyness * 0.12)));
        const volume = stableInteger(`${occSymbol}:volume`, 10, 900);
        const openInterest = stableInteger(`${occSymbol}:oi`, 100, 25_000);
        const quote = optionQuoteSchema.parse({
          occSymbol,
          underlying: root,
          bid: Math.max(0, model.price - width / 2),
          ask: model.price + width / 2,
          last: model.price,
          mark: model.price,
          volume,
          openInterest,
          impliedVolatility: iv,
          delta: model.delta,
          gamma: model.gamma,
          theta: model.theta,
          vega: model.vega,
          greeksSource: "computed",
          updatedAt: new Date().toISOString(),
        });
        result.push(optionChainItemSchema.parse({
          contract: { occSymbol, ...contract },
          quote,
        }));
      }
    }
    return result.sort((left, right) =>
      left.contract.strike - right.contract.strike ||
      (left.contract.type === right.contract.type ? 0 : left.contract.type === "call" ? -1 : 1),
    );
  }

  subscribeOptions(occSymbols: string[], onTick: OptionTickListener): () => void {
    const contracts = [...new Set(occSymbols)].map((symbol) => {
      const parsed = optionContractSchema.parse({
        ...parseOccSymbol(symbol),
        multiplier: 100,
      });
      return parsed;
    });
    const underlyings = [...new Set(contracts.map((contract) => contract.underlying))];
    return this.subscribe(underlyings, (tick) => {
      for (const contract of contracts.filter(({ underlying }) => underlying === tick.symbol)) {
        const expiryInstant = optionExpiryTimestamp(contract.expiry) * 1000;
        const timeToExpiry = Math.max(1 / 365, (expiryInstant - Date.now()) / (365 * 86400000));
        const impliedVolatility = 0.17 + Math.abs(Math.log(contract.strike / tick.last)) * 0.85 +
          0.015 * Math.sqrt(timeToExpiry) +
          stableFraction(`${contract.occSymbol}:iv`) * 0.012;
        const model = calculateBlackScholes({
          type: contract.type,
          spot: tick.last,
          strike: contract.strike,
          timeToExpiry,
          riskFreeRate: 0.045,
          volatility: impliedVolatility,
          dividendYield: contract.underlying === "SPY" ? 0.012 : 0,
        });
        const spread = Math.max(0.01, model.price * 0.02);
        const volume = (this.optionVolumes.get(contract.occSymbol) ?? stableInteger(`${contract.occSymbol}:volume`, 10, 900)) + 1;
        this.optionVolumes.set(contract.occSymbol, volume);
        onTick(optionQuoteSchema.parse({
          occSymbol: contract.occSymbol,
          underlying: contract.underlying,
          bid: Math.max(0, model.price - spread / 2),
          ask: model.price + spread / 2,
          last: model.price,
          mark: model.price,
          volume,
          openInterest: stableInteger(`${contract.occSymbol}:oi`, 100, 25_000),
          impliedVolatility,
          delta: model.delta,
          gamma: model.gamma,
          theta: model.theta,
          vega: model.vega,
          greeksSource: "computed",
          updatedAt: tick.updatedAt,
        }));
      }
    });
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

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function stableFraction(value: string): number {
  return stableHash(value) / 0xffff_ffff;
}

function stableInteger(value: string, min: number, max: number): number {
  return min + (stableHash(value) % (max - min + 1));
}
