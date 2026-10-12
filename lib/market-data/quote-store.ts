"use client";

import { useSyncExternalStore } from "react";
import { futuresQuoteSchema, optionQuoteSchema, quoteSchema, type FuturesQuote, type OptionQuote, type Quote } from "./schemas";

export type QuoteConnectionState = "connecting" | "live" | "stale" | "disconnected";
export type QuoteSnapshot = {
  quote: Quote;
  stale: boolean;
  history: number[];
  revision: number;
  flash: "up" | "down" | null;
};
export type OptionQuoteSnapshot = {
  quote: OptionQuote;
  stale: boolean;
  revision: number;
  flash: "up" | "down" | null;
};
export type FuturesQuoteSnapshot = { quote: FuturesQuote; stale: boolean };
const disconnectedStatus = { state: "disconnected" as const, lastUpdate: null };

export class QuoteStore {
  private readonly snapshots = new Map<string, QuoteSnapshot>();
  private readonly quoteListeners = new Map<string, Set<() => void>>();
  private readonly optionSnapshots = new Map<string, OptionQuoteSnapshot>();
  private readonly optionListeners = new Map<string, Set<() => void>>();
  private readonly futuresSnapshots = new Map<string, FuturesQuoteSnapshot>();
  private readonly futuresListeners = new Map<string, Set<() => void>>();
  private readonly statusListeners = new Set<() => void>();
  private connectionState: QuoteConnectionState = "disconnected";
  private lastUpdate: string | null = null;
  private statusSnapshot: { state: QuoteConnectionState; lastUpdate: string | null } = {
    state: "disconnected",
    lastUpdate: null,
  };

  get(symbol: string): QuoteSnapshot | undefined {
    return this.snapshots.get(symbol);
  }

  getStatus(): { state: QuoteConnectionState; lastUpdate: string | null } {
    return this.statusSnapshot;
  }

  getOption(occSymbol: string): OptionQuoteSnapshot | undefined {
    return this.optionSnapshots.get(occSymbol);
  }

  getFutures(symbol: string): FuturesQuoteSnapshot | undefined {
    return this.futuresSnapshots.get(symbol.toUpperCase());
  }

  subscribe(symbol: string, listener: () => void): () => void {
    const listeners = this.quoteListeners.get(symbol) ?? new Set();
    listeners.add(listener);
    this.quoteListeners.set(symbol, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.quoteListeners.delete(symbol);
    };
  }

  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  subscribeOption(occSymbol: string, listener: () => void): () => void {
    const listeners = this.optionListeners.get(occSymbol) ?? new Set();
    listeners.add(listener);
    this.optionListeners.set(occSymbol, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.optionListeners.delete(occSymbol);
    };
  }

  subscribeFutures(symbol: string, listener: () => void): () => void {
    const key = symbol.toUpperCase();
    const listeners = this.futuresListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.futuresListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.futuresListeners.delete(key);
    };
  }

  update(input: Quote): void {
    const quote = quoteSchema.parse(input);
    this.saveQuote(quote);
    this.notifyQuote(quote.symbol);
    if (quote.type === "future") {
      for (const listener of this.futuresListeners.get(quote.symbol.toUpperCase()) ?? []) listener();
    }
    this.lastUpdate = quote.updatedAt;
    this.refreshStatusSnapshot();
    this.refreshConnectionState();
    this.notifyStatus();
  }

  updateMany(quotes: Quote[]): void {
    const changed = new Set<string>();
    for (const input of quotes) {
      const quote = quoteSchema.parse(input);
      this.saveQuote(quote);
      changed.add(quote.symbol);
      if (quote.type === "future") {
        const futureQuote = futuresQuoteSchema.parse({
          symbol: quote.symbol,
          last: quote.last,
          bid: quote.bid,
          ask: quote.ask,
          settle: quote.settle ?? quote.prevSettle ?? quote.prevClose ?? null,
          prevSettle: quote.prevSettle ?? quote.prevClose ?? null,
          volume: quote.volume,
          openInterest: quote.openInterest ?? null,
          change: quote.change,
          lastUpdate: quote.updatedAt,
        });
        this.futuresSnapshots.set(quote.symbol.toUpperCase(), { quote: futureQuote, stale: false });
      }
      if (!this.lastUpdate || quote.updatedAt > this.lastUpdate) this.lastUpdate = quote.updatedAt;
    }
    for (const symbol of changed) {
      this.notifyQuote(symbol);
      for (const listener of this.futuresListeners.get(symbol.toUpperCase()) ?? []) listener();
    }
    if (changed.size > 0) {
      this.refreshStatusSnapshot();
      this.refreshConnectionState();
      this.notifyStatus();
    }
  }

  updateOptions(quotes: OptionQuote[]): void {
    const changed = new Set<string>();
    for (const input of quotes) {
      const quote = optionQuoteSchema.parse(input);
      const previous = this.optionSnapshots.get(quote.occSymbol);
      const previousPrice = previous?.quote.mark ?? previous?.quote.last;
      const nextPrice = quote.mark ?? quote.last;
      this.optionSnapshots.set(quote.occSymbol, {
        quote,
        stale: false,
        revision: (previous?.revision ?? 0) + 1,
        flash: previousPrice === null || previousPrice === undefined || nextPrice === null
          ? null
          : nextPrice > previousPrice ? "up" : nextPrice < previousPrice ? "down" : null,
      });
      changed.add(quote.occSymbol);
    }
    for (const occSymbol of changed) {
      for (const listener of this.optionListeners.get(occSymbol) ?? []) listener();
    }
  }

  setConnectionState(state: QuoteConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.refreshStatusSnapshot();
    this.notifyStatus();
  }

  markStale(now = Date.now(), staleAfterMs = 15_000): void {
    let changed = false;
    for (const [symbol, snapshot] of this.snapshots) {
      const isMarketOpen = marketOpenFor(snapshot.quote.type, now);
      const stale = isMarketOpen && now - Date.parse(snapshot.quote.updatedAt) > staleAfterMs;
      if (snapshot.stale !== stale) {
        this.snapshots.set(symbol, { ...snapshot, stale });
        this.notifyQuote(symbol);
        changed = true;
      }
    }
    for (const [occSymbol, snapshot] of this.optionSnapshots) {
      const stale = marketOpenFor("stock", now) && now - Date.parse(snapshot.quote.updatedAt) > staleAfterMs;
      if (snapshot.stale !== stale) {
        this.optionSnapshots.set(occSymbol, { ...snapshot, stale });
        for (const listener of this.optionListeners.get(occSymbol) ?? []) listener();
        changed = true;
      }
      for (const [symbol, snapshot] of this.futuresSnapshots) {
        const stale = now - Date.parse(snapshot.quote.lastUpdate) > staleAfterMs;
        if (snapshot.stale !== stale) {
          this.futuresSnapshots.set(symbol, { ...snapshot, stale });
          for (const listener of this.futuresListeners.get(symbol) ?? []) listener();
          changed = true;
        }
      }
    }
    const hasRecentTick = [...this.snapshots.values()].some(
      ({ quote }) => marketOpenFor(quote.type, now) && now - Date.parse(quote.updatedAt) <= staleAfterMs,
    ) || [...this.optionSnapshots.values()].some(
      ({ quote }) => marketOpenFor("stock", now) && now - Date.parse(quote.updatedAt) <= staleAfterMs,
    );
    if (this.connectionState === "live" && !hasRecentTick) this.setConnectionState("stale");
    if (changed) this.notifyStatus();
  }

  private refreshConnectionState(): void {
    if (this.connectionState === "disconnected" || this.connectionState === "connecting") return;
    if (this.connectionState === "live") return;
    this.connectionState = "live";
    this.refreshStatusSnapshot();
    this.notifyStatus();
  }

  private saveQuote(quote: Quote): void {
    const previous = this.snapshots.get(quote.symbol);
    const history = previous?.history ?? [];
    const nextHistory = [...history, quote.last].slice(-32);
    this.snapshots.set(quote.symbol, {
      quote,
      stale: false,
      history: nextHistory,
      revision: (previous?.revision ?? 0) + 1,
      flash: previous ? quote.last > previous.quote.last ? "up" : quote.last < previous.quote.last ? "down" : null : null,
    });
  }

  private refreshStatusSnapshot(): void {
    this.statusSnapshot = { state: this.connectionState, lastUpdate: this.lastUpdate };
  }

  private notifyQuote(symbol: string): void {
    for (const listener of this.quoteListeners.get(symbol) ?? []) listener();
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) listener();
  }
}

function marketOpenFor(type: Quote["type"], now: number): boolean {
  if (type === "future") return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type: part, value }) => [part, value]));
  const weekday = values.weekday !== "Sat" && values.weekday !== "Sun";
  const minuteOfDay = Number(values.hour) * 60 + Number(values.minute);
  return weekday && minuteOfDay >= 570 && minuteOfDay < 960;
}

export const quoteStore = new QuoteStore();

export function useQuote(symbol: string): QuoteSnapshot | undefined {
  return useSyncExternalStore(
    (listener) => quoteStore.subscribe(symbol, listener),
    () => quoteStore.get(symbol),
    () => undefined,
  );
}

export function useQuoteConnection(): ReturnType<QuoteStore["getStatus"]> {
  return useSyncExternalStore(
    (listener) => quoteStore.subscribeStatus(listener),
    () => quoteStore.getStatus(),
    () => disconnectedStatus,
  );
}

export function useOptionQuote(occSymbol: string): OptionQuoteSnapshot | undefined {
  return useSyncExternalStore(
    (listener) => quoteStore.subscribeOption(occSymbol, listener),
    () => quoteStore.getOption(occSymbol),
    () => undefined,
  );
}

export function useFuturesQuote(symbol: string): FuturesQuoteSnapshot | undefined {
  return useSyncExternalStore(
    (listener) => quoteStore.subscribeFutures(symbol, listener),
    () => quoteStore.getFutures(symbol),
    () => undefined,
  );
}
