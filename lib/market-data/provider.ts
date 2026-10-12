import type {
  Bar,
  FuturesContract,
  InstrumentSearchResult,
  OptionChainItem,
  OptionQuote,
  Quote,
  Tick,
} from "./schemas";
import type { Bar as AggregatedBar } from "@/services/ibkr-bridge/src/bar-aggregator";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1M";
export type BarRange = { from: number; to: number; limit?: number };
export type TickListener = (tick: Tick) => void;
export type BarListener = (symbol: string, bar: AggregatedBar) => void;
export type OptionTickListener = (tick: OptionQuote) => void;
export type ProviderStreamStatus = {
  state?: "disconnected" | "connecting" | "reconnecting" | "live";
  marketDataType?: number;
  activeLines?: number;
  code?: number;
  message?: string;
  action?: string;
};
export interface MarketDataProvider {
  getQuote(symbols: string[]): Promise<Quote[]>;
  getBars(symbol: string, timeframe: Timeframe, range: BarRange): Promise<Bar[]>;
  getOptionExpiries(underlying: string): Promise<string[]>;
  getOptionChain(underlying: string, expiry: string): Promise<OptionChainItem[]>;
  getFuturesCurve(root: string): Promise<FuturesContract[]>;
  subscribe(
    symbols: string[],
    onTick: TickListener,
    onBar?: BarListener,
    timeframe?: Timeframe,
    onStatus?: (status: ProviderStreamStatus, event: "status" | "error") => void,
    evictable?: boolean,
  ): () => void;
  subscribeOptions(occSymbols: string[], onTick: OptionTickListener): () => void;
  searchSymbols?(query: string): Promise<InstrumentSearchResult[]>;
}
