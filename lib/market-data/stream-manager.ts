"use client";

import { optionQuoteSchema, quoteSchema, type Bar, type OptionQuote, type Quote, type Tick } from "./schemas";
import type { OptionTickListener, Timeframe } from "./provider";
import { quoteStore } from "./quote-store";

type TickListener = (tick: Tick) => void;
type BarListener = (symbol: string, bar: Bar) => void;
type StreamStatus = {
  state?: "disconnected" | "connecting" | "reconnecting" | "live";
  message?: string;
  action?: string;
};

const FLUSH_INTERVAL_MS = 150;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
  "1w": 604_800,
  "1M": 2_592_000,
};

export class MarketStreamManager {
  constructor(private readonly staleAfterMs = 15_000) {}

  private readonly consumers = new Map<string, Set<symbol>>();
  private readonly optionConsumers = new Map<string, Set<symbol>>();
  private readonly pending = new Map<string, Quote>();
  private readonly pendingOptions = new Map<string, OptionQuote>();
  private readonly barListeners = new Map<string, Set<{ timeframe: Timeframe; listener: BarListener }>>();
  private readonly currentBars = new Map<string, Bar>();
  private readonly lastVolumes = new Map<string, number>();
  private readonly lastPrices = new Map<string, number>();
  private readonly statuses = new Set<(status: StreamStatus, event: "status" | "error") => void>();
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private staleTimer: ReturnType<typeof setInterval> | undefined;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private abortController: AbortController | undefined;
  private running = false;
  private reconnectAttempt = 0;
  private status: StreamStatus["state"] = "disconnected";
  private lastError = "";

  subscribe(
    symbols: string[],
    onTick?: TickListener,
    options: { timeframe?: Timeframe; onBar?: BarListener } = {},
  ): () => void {
    const listener = onTick ?? (() => {});
    const token = Symbol("market-stream-consumer");
    for (const symbol of new Set(symbols)) {
      const listeners = this.consumers.get(symbol) ?? new Set();
      listeners.add(token);
      this.consumers.set(symbol, listeners);
    }
    if (options.onBar) {
      for (const symbol of new Set(symbols)) {
        const listeners = this.barListeners.get(symbol) ?? new Set();
        listeners.add({ timeframe: options.timeframe ?? "1m", listener: options.onBar });
        this.barListeners.set(symbol, listeners);
      }
    }
    const tickCallbacks = new Map<string, TickListener>();
    for (const symbol of new Set(symbols)) tickCallbacks.set(symbol, listener);
    this.tickSubscriptions.set(token, tickCallbacks);
    this.ensureTimers();
    this.scheduleReconcile();
    return () => {
      for (const symbol of new Set(symbols)) {
        const listeners = this.consumers.get(symbol);
        listeners?.delete(token);
        if (!listeners?.size) {
          this.consumers.delete(symbol);
          this.barListeners.delete(symbol);
          this.currentBars.delete(symbol);
        }
      }
      this.tickSubscriptions.delete(token);
      if (options.onBar) {
        for (const symbol of new Set(symbols)) {
          const listeners = this.barListeners.get(symbol);
          for (const barListener of listeners ?? []) {
            if (barListener.listener === options.onBar) listeners?.delete(barListener);
          }
        }
      }
      this.scheduleReconcile();
    };
  }

  subscribeOptions(occSymbols: string[], onTick?: OptionTickListener): () => void {
    const uniqueSymbols = [...new Set(occSymbols.map((symbol) => symbol.trim().toUpperCase()))];
    const token = Symbol("option-stream-consumer");
    for (const occSymbol of uniqueSymbols) {
      const consumers = this.optionConsumers.get(occSymbol) ?? new Set<symbol>();
      consumers.add(token);
      this.optionConsumers.set(occSymbol, consumers);
    }
    const callbacks = new Map<string, OptionTickListener>();
    if (onTick) for (const occSymbol of uniqueSymbols) callbacks.set(occSymbol, onTick);
    this.optionSubscriptions.set(token, callbacks);
    this.ensureTimers();
    this.scheduleReconcile();
    return () => {
      for (const occSymbol of uniqueSymbols) {
        const consumers = this.optionConsumers.get(occSymbol);
        consumers?.delete(token);
        if (!consumers?.size) {
          this.optionConsumers.delete(occSymbol);
          this.pendingOptions.delete(occSymbol);
        }
      }
      this.optionSubscriptions.delete(token);
      this.scheduleReconcile();
    };
  }

  subscribeStatus(
    listener: (status: StreamStatus, event: "status" | "error") => void,
  ): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }

  seedBar(symbol: string, timeframe: Timeframe, bar: Bar): void {
    const key = `${symbol}:${timeframe}`;
    const current = this.currentBars.get(key);
    if (!current || current.time < bar.time) {
      this.currentBars.set(key, bar);
      return;
    }
    if (current.time === bar.time) {
      this.currentBars.set(key, {
        ...bar,
        high: Math.max(bar.high, current.high),
        low: Math.min(bar.low, current.low),
        close: current.close,
        volume: Math.max(bar.volume, current.volume),
      });
    }
  }

  private readonly tickSubscriptions = new Map<symbol, Map<string, TickListener>>();
  private readonly optionSubscriptions = new Map<symbol, Map<string, OptionTickListener>>();

  private ensureTimers(): void {
    this.flushTimer ??= setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.staleTimer ??= setInterval(() => quoteStore.markStale(Date.now(), this.staleAfterMs), 2_000);
  }

  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      const symbols = [...this.consumers.keys()].sort();
      const optionSymbols = [...this.optionConsumers.keys()].sort();
      const key = `q:${symbols.join(",")}|o:${optionSymbols.join(",")}`;
      if (this.running && key === this.streamKey) return;
      this.streamKey = key;
      this.abortController?.abort();
      this.running = false;
      if (symbols.length || optionSymbols.length) void this.connect(symbols, optionSymbols);
      else {
        this.setState("disconnected");
        if (this.flushTimer) clearInterval(this.flushTimer);
        if (this.staleTimer) clearInterval(this.staleTimer);
        this.flushTimer = undefined;
        this.staleTimer = undefined;
        this.pending.clear();
        this.pendingOptions.clear();
        this.lastVolumes.clear();
        this.lastPrices.clear();
        this.streamKey = "";
      }
    }, 0);
  }

  private streamKey = "";

  private async connect(symbols: string[], optionSymbols: string[]): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    this.running = true;
    this.setState(this.reconnectAttempt ? "connecting" : "connecting");
    try {
      const params = new URLSearchParams();
      for (const symbol of symbols) params.append("symbol", symbol);
      for (const occSymbol of optionSymbols) params.append("optionSymbol", occSymbol);
      const response = await fetch(`/api/stream?${params}`, {
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Market stream failed with HTTP ${response.status}.`);
      }
      this.lastError = "";
      this.setState("live");
      await this.readEvents(response.body, controller.signal);
      if (!controller.signal.aborted) throw new Error("Market stream ended unexpectedly.");
    } catch (error) {
      if (controller.signal.aborted) return;
      this.running = false;
      this.lastError = error instanceof Error ? error.message : "Market stream disconnected.";
      this.setState("disconnected");
      this.broadcast({ message: this.lastError }, "error");
      const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.reconnectAttempt++);
      const wait = Math.round(base * (0.75 + Math.random() * 0.5));
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (this.consumers.size || this.optionConsumers.size) {
        void this.connect([...this.consumers.keys()].sort(), [...this.optionConsumers.keys()].sort());
      }
    }
  }

  private async readEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        this.handleEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  private handleEvent(block: string): void {
    let eventName = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data.join("\n")) as unknown;
    } catch {
      this.lastError = "Received malformed data from the market stream.";
      return;
    }
    if (eventName === "tick") {
      const parsed = quoteSchema.safeParse(payload);
      if (!parsed.success) return;
      this.pending.set(parsed.data.symbol, parsed.data);
      this.reconnectAttempt = 0;
      this.emitLiveBar(parsed.data);
      return;
    }
    if (eventName === "optionTick") {
      const parsed = optionQuoteSchema.safeParse(payload);
      if (!parsed.success) return;
      this.pendingOptions.set(parsed.data.occSymbol, parsed.data);
      this.reconnectAttempt = 0;
      return;
    }
    if (eventName === "status" && isStreamStatus(payload)) {
      if (payload.state === "live") this.setState("live");
      else if (payload.state === "connecting" || payload.state === "reconnecting") this.setState("connecting");
      else if (payload.state === "disconnected") this.setState("disconnected");
      this.broadcast(payload, "status");
      return;
    }
    if (eventName === "error" && isStreamStatus(payload)) {
      this.lastError = payload.action ?? payload.message ?? "Market stream error.";
      this.broadcast(payload, "error");
    }
  }

  private flush(): void {
    if (this.pending.size) {
      const changed = [...this.pending.values()];
      this.pending.clear();
      quoteStore.updateMany(changed);
      for (const tick of changed) {
        for (const callbackMap of this.tickSubscriptions.values()) {
          callbackMap.get(tick.symbol)?.(tick);
        }
      }
    }
    if (this.pendingOptions.size) {
      const changed = [...this.pendingOptions.values()];
      this.pendingOptions.clear();
      quoteStore.updateOptions(changed);
      for (const tick of changed) {
        for (const callbackMap of this.optionSubscriptions.values()) {
          callbackMap.get(tick.occSymbol)?.(tick);
        }
      }
    }
  }

  private emitLiveBar(quote: Quote): void {
    const listeners = this.barListeners.get(quote.symbol);
    if (!listeners?.size) return;
    const epoch = Math.floor(Date.parse(quote.updatedAt) / 1000);
    for (const { timeframe, listener } of listeners) {
      const duration = TIMEFRAME_SECONDS[timeframe];
      const bucketTime = timeframe === "1w" || timeframe === "1M"
        ? calendarBucket(epoch, timeframe)
        : Math.floor(epoch / duration) * duration;
      const key = `${quote.symbol}:${timeframe}`;
      const previous = this.currentBars.get(key);
      const previousVolume = this.lastVolumes.get(quote.symbol) ?? quote.volume;
      const previousPrice = this.lastPrices.get(quote.symbol);
      const volumeDelta = Math.max(0, quote.volume - previousVolume);
      const tickVolume = volumeDelta || (previousPrice !== quote.last ? quote.lastSize ?? 0 : 0);
      this.lastVolumes.set(quote.symbol, quote.volume);
      this.lastPrices.set(quote.symbol, quote.last);
      const bar: Bar = previous && previous.time === bucketTime
        ? {
            ...previous,
            high: Math.max(previous.high, quote.last),
            low: Math.min(previous.low, quote.last),
            close: quote.last,
            volume: previous.volume + tickVolume,
          }
        : {
            time: bucketTime,
            open: quote.last,
            high: quote.last,
            low: quote.last,
            close: quote.last,
            volume: tickVolume,
          };
      this.currentBars.set(key, bar);
      listener(quote.symbol, bar);
    }
  }

  private setState(state: NonNullable<StreamStatus["state"]>): void {
    this.status = state;
    quoteStore.setConnectionState(state === "reconnecting" ? "connecting" : state);
    this.broadcast({ state, ...(this.lastError ? { message: this.lastError } : {}) }, "status");
  }

  private broadcast(status: StreamStatus, event: "status" | "error"): void {
    for (const listener of this.statuses) listener(status, event);
  }
}

function isStreamStatus(value: unknown): value is StreamStatus {
  return typeof value === "object" && value !== null;
}

function calendarBucket(epochSeconds: number, timeframe: "1w" | "1M"): number {
  const date = new Date(epochSeconds * 1000);
  if (timeframe === "1w") {
    const weekday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - weekday);
  } else {
    date.setUTCDate(1);
  }
  date.setUTCHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export const marketStreamManager = new MarketStreamManager();
