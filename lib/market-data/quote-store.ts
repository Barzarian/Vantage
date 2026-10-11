"use client";

import { useSyncExternalStore } from "react";
import { quoteSchema, type Quote } from "./schemas";

export type QuoteConnectionState = "connecting" | "live" | "stale" | "disconnected";
export type QuoteSnapshot = { quote: Quote; stale: boolean; history: number[] };

export class QuoteStore {
  private readonly snapshots = new Map<string, QuoteSnapshot>();
  private readonly quoteListeners = new Map<string, Set<() => void>>();
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

  update(input: Quote): void {
    const quote = quoteSchema.parse(input);
    this.saveQuote(quote);
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
      if (!this.lastUpdate || quote.updatedAt > this.lastUpdate) this.lastUpdate = quote.updatedAt;
    }
    for (const symbol of changed) this.notifyQuote(symbol);
    if (changed.size > 0) {
      this.refreshStatusSnapshot();
      this.refreshConnectionState();
      this.notifyStatus();
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
    const hasRecentTick = [...this.snapshots.values()].some(
      ({ quote }) => marketOpenFor(quote.type, now) && now - Date.parse(quote.updatedAt) <= staleAfterMs,
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
    const history = this.snapshots.get(quote.symbol)?.history ?? [];
    const nextHistory = [...history, quote.last].slice(-32);
    this.snapshots.set(quote.symbol, { quote, stale: false, history: nextHistory });
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
    () => ({ state: "disconnected", lastUpdate: null }),
  );
}
