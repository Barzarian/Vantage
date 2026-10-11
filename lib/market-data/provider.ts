import type { Bar, FuturesContract, OptionContract, Quote, Tick } from "./schemas";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "1d" | "1w" | "1M";
export type BarRange = { from: number; to: number; limit?: number };
export type TickListener = (tick: Tick) => void;

export interface MarketDataProvider {
  getQuote(symbols: string[]): Promise<Quote[]>;
  getBars(symbol: string, timeframe: Timeframe, range: BarRange): Promise<Bar[]>;
  getOptionChain(underlying: string, expiry?: string): Promise<OptionContract[]>;
  getFuturesCurve(root: string): Promise<FuturesContract[]>;
  subscribe(symbols: string[], onTick: TickListener): () => void;
}
