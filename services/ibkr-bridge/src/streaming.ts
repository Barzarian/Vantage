import { EventName, type IBApi } from "@stoqey/ib";
import { TickType } from "@stoqey/ib/dist/api/market/tickType.js";
import type { ResolvedContract } from "./contracts.js";
import { toIbContract } from "./contracts.js";
import { BarAggregator, type AggregateTimeframe, type Bar } from "./bar-aggregator.js";
import type { HistoricalDataService } from "./history.js";

export type DataType = "realtime" | "delayed" | "frozen";
export type NormalizedQuote = {
  conId: number;
  symbol: string;
  name: string;
  type: "stock" | "future" | "index";
  last: number;
  change: number;
  changePercent: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  lastSize: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  updatedAt: string;
  dataType: DataType;
};

type AccumulatorValues = {
  last?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  lastSize?: number;
  volume?: number;
  high?: number;
  low?: number;
  open?: number;
  prevClose?: number;
  timestamp?: number;
};

const DELAYED_PRICE_TYPES = new Map<number, number>([
  [TickType.DELAYED_BID, TickType.BID],
  [TickType.DELAYED_ASK, TickType.ASK],
  [TickType.DELAYED_LAST, TickType.LAST],
  [TickType.DELAYED_HIGH, TickType.HIGH],
  [TickType.DELAYED_LOW, TickType.LOW],
  [TickType.DELAYED_CLOSE, TickType.CLOSE],
  [TickType.DELAYED_OPEN, TickType.OPEN],
]);
const DELAYED_SIZE_TYPES = new Map<number, number>([
  [TickType.DELAYED_BID_SIZE, TickType.BID_SIZE],
  [TickType.DELAYED_ASK_SIZE, TickType.ASK_SIZE],
  [TickType.DELAYED_LAST_SIZE, TickType.LAST_SIZE],
  [TickType.DELAYED_VOLUME, TickType.VOLUME],
]);

export function mapMarketDataType(value: number): DataType {
  if (value === 2 || value === 4) return "frozen";
  if (value === 3) return "delayed";
  return "realtime";
}

export class QuoteAccumulator {
  private readonly values: AccumulatorValues = {};
  private dataType: DataType;

  constructor(private readonly contract: ResolvedContract, initialType: DataType) {
    this.dataType = initialType;
  }

  setDataType(value: number): void {
    this.dataType = mapMarketDataType(value);
  }

  updatePrice(tickType: number, value: number): NormalizedQuote | undefined {
    if (!Number.isFinite(value) || value < 0) return undefined;
    const normalizedType = DELAYED_PRICE_TYPES.get(tickType) ?? tickType;
    if (DELAYED_PRICE_TYPES.has(tickType)) this.dataType = "delayed";
    switch (normalizedType) {
      case TickType.BID: this.values.bid = value; break;
      case TickType.ASK: this.values.ask = value; break;
      case TickType.LAST: this.values.last = value; break;
      case TickType.HIGH: this.values.high = value; break;
      case TickType.LOW: this.values.low = value; break;
      case TickType.OPEN: this.values.open = value; break;
      case TickType.CLOSE: this.values.prevClose = value; break;
      case TickType.LAST_TIMESTAMP: this.values.timestamp = value; break;
      default: return undefined;
    }
    return this.snapshot();
  }

  updateSize(tickType: number, value: number): NormalizedQuote | undefined {
    if (!Number.isFinite(value) || value < 0) return undefined;
    const normalizedType = DELAYED_SIZE_TYPES.get(tickType) ?? tickType;
    if (DELAYED_SIZE_TYPES.has(tickType)) this.dataType = "delayed";
    switch (normalizedType) {
      case TickType.BID_SIZE: this.values.bidSize = value; break;
      case TickType.ASK_SIZE: this.values.askSize = value; break;
      case TickType.VOLUME: this.values.volume = value; break;
      case TickType.LAST_SIZE: this.values.lastSize = value; break;
      default: return undefined;
    }
    return this.snapshot();
  }

  updateString(tickType: number, value: string): NormalizedQuote | undefined {
    if (tickType !== TickType.LAST_TIMESTAMP) return undefined;
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
    this.values.timestamp = timestamp;
    return this.snapshot();
  }

  snapshot(): NormalizedQuote | undefined {
    const prevClose = this.values.prevClose ?? 0;
    const last = this.values.last ?? 0;
    const change = prevClose > 0 && last > 0 ? last - prevClose : 0;
    return {
      conId: this.contract.conId,
      symbol: this.contract.symbol,
      name: this.contract.name,
      type: this.contract.secType === "FUT" ? "future" : this.contract.secType === "IND" ? "index" : "stock",
      last,
      change,
      changePercent: prevClose > 0 ? (change / prevClose) * 100 : 0,
      bid: this.values.bid ?? 0,
      ask: this.values.ask ?? 0,
      bidSize: this.values.bidSize ?? 0,
      askSize: this.values.askSize ?? 0,
      lastSize: this.values.lastSize ?? 0,
      volume: this.values.volume ?? 0,
      high: this.values.high ?? 0,
      low: this.values.low ?? 0,
      open: this.values.open ?? 0,
      prevClose,
      updatedAt: new Date((this.values.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
      dataType: this.dataType,
    };
  }
}

type TickListener = (quote: NormalizedQuote) => void;
type BarListener = (bar: Bar) => void;
type ErrorListener = (error: { code: number; message: string; conId?: number }) => void;
type ActiveSubscription = {
  reqId: number;
  contract: ResolvedContract;
  accumulator: QuoteAccumulator;
  listeners: Set<TickListener>;
  barListeners: Set<{ timeframe: AggregateTimeframe; listener: BarListener }>;
  evictableListeners: Map<TickListener, boolean>;
  lastUsedAt: number;
  evicted: boolean;
};

export class LineLimitError extends Error {
  constructor(readonly limit: number) {
    super(`IBKR market data line limit reached (${limit}). Unsubscribe from symbols to free a line.`);
    this.name = "LineLimitError";
  }
}

export class MarketDataSubscriptions {
  private readonly byId = new Map<number, ActiveSubscription>();
  private readonly byConId = new Map<number, ActiveSubscription>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly barAggregator = new BarAggregator();
  private nextRequestId = 10_000;
  private attachedApi: IBApi | undefined;

  constructor(
    private readonly getApi: () => IBApi,
    private readonly lineLimit = 100,
    private readonly initialDataType: DataType = "delayed",
    private readonly evictLeastRecentlyUsed = false,
  ) {}

  get activeLines() {
    return this.byConId.size;
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  subscribe(
    contract: ResolvedContract,
    listener: TickListener,
    onBar?: BarListener,
    timeframe: AggregateTimeframe = "1m",
    evictable = false,
  ): () => void {
    const api = this.getApi();
    this.attach(api);
    let entry = this.byConId.get(contract.conId);
    if (!entry) {
      if (this.byConId.size >= this.lineLimit) {
        if (!this.evictLeastRecentlyUsed || !this.evictLeastRecentlyUsedLine()) {
          throw new LineLimitError(this.lineLimit);
        }
      }
      entry = {
        reqId: this.nextRequestId++,
        contract,
        accumulator: new QuoteAccumulator(contract, this.initialDataType),
        listeners: new Set(),
        barListeners: new Set(),
        evictableListeners: new Map(),
        lastUsedAt: Date.now(),
        evicted: false,
      };
      this.byConId.set(contract.conId, entry);
      this.byId.set(entry.reqId, entry);
      try {
        api.reqMktData(entry.reqId, toIbContract(contract), "", false, false);
      } catch (error) {
        this.byConId.delete(contract.conId);
        this.byId.delete(entry.reqId);
        throw error;
      }
    }
    entry.listeners.add(listener);
    entry.evictableListeners.set(listener, evictable);
    entry.lastUsedAt = Date.now();
    const barSubscription = onBar ? { timeframe, listener: onBar } : undefined;
    if (barSubscription) entry.barListeners.add(barSubscription);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      entry!.listeners.delete(listener);
      entry!.evictableListeners.delete(listener);
      if (barSubscription) entry!.barListeners.delete(barSubscription);
      if (entry!.listeners.size !== 0 || entry!.barListeners.size !== 0) return;
      this.byConId.delete(contract.conId);
      this.byId.delete(entry!.reqId);
      if (entry!.evicted) return;
      try {
        api.cancelMktData(entry!.reqId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "cancelMktData failed";
        console.error(`[ibkr] could not cancel market data for conId ${contract.conId}: ${message}`);
      }
    };
  }

  snapshot(conId: number): NormalizedQuote | undefined {
    return this.byConId.get(conId)?.accumulator.snapshot();
  }

  resubscribe(): void {
    let api: IBApi;
    try {
      api = this.getApi();
    } catch {
      return;
    }
    const alreadyAttached = api === this.attachedApi;
    this.attach(api);
    if (!alreadyAttached) return;
    for (const entry of this.byConId.values()) {
      try {
        api.reqMktData(entry.reqId, toIbContract(entry.contract), "", false, false);
      } catch (error) {
        const message = error instanceof Error ? error.message : "market-data resubscribe failed";
        for (const listener of this.errorListeners) {
          listener({ code: 0, message, conId: entry.contract.conId });
        }
      }
    }
  }

  async recoverBars(history: HistoricalDataService): Promise<void> {
    const latestByFrame = new Map<string, {
      entry: ActiveSubscription;
      timeframe: AggregateTimeframe;
      lastTime: number;
    }>();
    for (const entry of this.byConId.values()) {
      for (const { timeframe } of entry.barListeners) {
        const key = `${entry.contract.conId}:${timeframe}`;
        const latest = this.barAggregator.getBars(entry.contract.symbol, timeframe).at(-1);
        if (latest) latestByFrame.set(key, { entry, timeframe, lastTime: latest.time });
      }
    }
    for (const item of latestByFrame.values()) {
      const from = item.lastTime;
      const to = Math.floor(Date.now() / 1000);
      if (to <= from) continue;
      try {
        const recovered = await history.getBars(item.entry.contract, item.timeframe, from, to);
        for (const bar of recovered) {
          if (bar.time < item.lastTime) continue;
          for (const subscription of item.entry.barListeners) {
            if (subscription.timeframe === item.timeframe) subscription.listener(bar);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Historical gap recovery failed.";
        for (const listener of this.errorListeners) {
          listener({ code: 0, message, conId: item.entry.contract.conId });
        }
      }
    }
  }

  dispose(): void {
    const api = this.attachedApi;
    if (api) {
      for (const entry of this.byConId.values()) api.cancelMktData(entry.reqId);
      api.removeListener(EventName.tickPrice, this.onPrice);
      api.removeListener(EventName.tickSize, this.onSize);
      api.removeListener(EventName.tickString, this.onString);
      api.removeListener(EventName.marketDataType, this.onMarketDataType);
      api.removeListener(EventName.error, this.onIbError);
    }
    this.byConId.clear();
    this.byId.clear();
    this.attachedApi = undefined;
  }

  private readonly onPrice = (reqId: number, field: number, value: number) => {
    const entry = this.byId.get(reqId);
    const quote = entry?.accumulator.updatePrice(field, value);
    if (quote && entry) {
      this.emit(entry, quote);
      if (field === TickType.LAST || field === TickType.DELAYED_LAST) {
        this.emitBar(entry, quote, 0);
      }
    }
  };

  private readonly onSize = (reqId: number, field?: number, value?: number) => {
    if (field === undefined || value === undefined) return;
    const entry = this.byId.get(reqId);
    const quote = entry?.accumulator.updateSize(field, value);
    if (quote && entry) {
      this.emit(entry, quote);
      if (field === TickType.LAST_SIZE || field === TickType.DELAYED_LAST_SIZE) {
        this.emitBar(entry, quote, value);
      }
    }
  };

  private readonly onString = (reqId: number, field: number, value: string) => {
    const entry = this.byId.get(reqId);
    const quote = entry?.accumulator.updateString(field, value);
    if (quote && entry) this.emit(entry, quote);
  };

  private readonly onMarketDataType = (reqId: number, type: number) => {
    const entry = this.byId.get(reqId);
    if (!entry) return;
    entry.accumulator.setDataType(type);
    this.emit(entry, entry.accumulator.snapshot()!);
  };

  private readonly onIbError = (error: Error, code: number, reqId: number) => {
    const entry = this.byId.get(reqId);
    if (code === 10167) {
      if (entry) {
        entry.accumulator.setDataType(3);
        this.emit(entry, entry.accumulator.snapshot()!);
      }
      return;
    }
    if (code === 2104 || code === 2106 || code === 2158) return;
    for (const listener of this.errorListeners) {
      listener({ code, message: error.message, conId: entry?.contract.conId });
    }
  };

  private attach(api: IBApi): void {
    if (api === this.attachedApi) return;
    const reconnecting = this.attachedApi !== undefined;
    if (this.attachedApi) {
      this.attachedApi.removeListener(EventName.tickPrice, this.onPrice);
      this.attachedApi.removeListener(EventName.tickSize, this.onSize);
      this.attachedApi.removeListener(EventName.tickString, this.onString);
      this.attachedApi.removeListener(EventName.marketDataType, this.onMarketDataType);
      this.attachedApi.removeListener(EventName.error, this.onIbError);
    }
    this.attachedApi = api;
    api.on(EventName.tickPrice, this.onPrice);
    api.on(EventName.tickSize, this.onSize);
    api.on(EventName.tickString, this.onString);
    api.on(EventName.marketDataType, this.onMarketDataType);
    api.on(EventName.error, this.onIbError);
    if (reconnecting) {
      this.byId.clear();
      for (const entry of this.byConId.values()) {
        entry.reqId = this.nextRequestId++;
        this.byId.set(entry.reqId, entry);
        try {
          api.reqMktData(entry.reqId, toIbContract(entry.contract), "", false, false);
        } catch (error) {
          const message = error instanceof Error ? error.message : "market-data resubscribe failed";
          for (const listener of this.errorListeners) {
            listener({ code: 0, message, conId: entry.contract.conId });
          }
        }
      }
    }
  }

  private emit(entry: ActiveSubscription, quote: NormalizedQuote): void {
    entry.lastUsedAt = Date.now();
    for (const listener of entry.listeners) listener(quote);
  }

  private emitBar(entry: ActiveSubscription, quote: NormalizedQuote, volume: number): void {
    entry.lastUsedAt = Date.now();
    const timestamp = Math.floor(Date.parse(quote.updatedAt) / 1000);
    const frames = new Set([...entry.barListeners].map((subscription) => subscription.timeframe));
    const bars = new Map<AggregateTimeframe, Bar>();
    for (const timeframe of frames) {
      bars.set(
        timeframe,
        this.barAggregator.update(entry.contract.symbol, timeframe, timestamp, quote.last, volume),
      );
    }
    for (const subscription of entry.barListeners) {
      const bar = bars.get(subscription.timeframe);
      if (bar) subscription.listener(bar);
    }
  }

  private evictLeastRecentlyUsedLine(): boolean {
    const candidate = [...this.byConId.values()]
      .filter(
        (entry) =>
          entry.barListeners.size === 0 &&
          entry.evictableListeners.size > 0 &&
          [...entry.evictableListeners.values()].every(Boolean),
      )
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!candidate) return false;
    this.byConId.delete(candidate.contract.conId);
    this.byId.delete(candidate.reqId);
    candidate.evicted = true;
    try {
      this.attachedApi?.cancelMktData(candidate.reqId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "could not cancel evicted line";
      console.error(`[ibkr] LRU eviction cancel failed: ${message}`);
    }
    for (const listener of this.errorListeners) {
      listener({
        code: 0,
        message: `IBKR market-data line for ${candidate.contract.symbol} was evicted by the configured LRU policy.`,
        conId: candidate.contract.conId,
      });
    }
    return true;
  }
}
