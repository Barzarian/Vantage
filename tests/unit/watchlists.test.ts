import { describe, expect, it, vi } from "vitest";
import { barBucketStart, BarAggregator } from "../../services/ibkr-bridge/src/bar-aggregator";
import { QuoteStore } from "../../lib/market-data/quote-store";
import { formatPrice } from "../../lib/watchlists/preferences";
import { reorderByIds, WatchlistError } from "../../lib/watchlists/model";
import { sessionVolumeWeightedAveragePrice } from "../../lib/indicators";
import type { Quote } from "../../lib/market-data/schemas";
import {
  addWatchlistItem,
  createWatchlist,
  deleteWatchlist,
  duplicateWatchlist,
  getWatchlists,
  removeWatchlistItem,
  renameWatchlist,
  reorderWatchlistItems,
  updateWatchlistItem,
} from "../../lib/watchlists/service";

function quote(symbol: string, last: number): Quote {
  return {
    symbol,
    name: symbol,
    type: "stock",
    last,
    change: 0,
    changePercent: 0,
    bid: last - 0.01,
    ask: last + 0.01,
    volume: 100,
    dayLow: last - 1,
    dayHigh: last + 1,
    weekLow: last - 2,
    weekHigh: last + 2,
    updatedAt: new Date("2026-10-11T10:00:00.000Z").toISOString(),
  };
}

describe("watchlist/chart utility behavior", () => {
  it("reorders only when every item ID is represented exactly once", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(reorderByIds(items, ["c", "a", "b"])).toEqual([items[2], items[0], items[1]]);
    expect(() => reorderByIds(items, ["a", "a", "b"])).toThrow(WatchlistError);
    expect(() => reorderByIds(items, ["a", "b", "missing"])).toThrow(WatchlistError);
  });

  it("formats prices with stable equity and futures precision", () => {
    expect(formatPrice(228.6, "AAPL", "stock")).toBe("228.60");
    expect(formatPrice(72.8, "CL", "future")).toBe("72.80");
    expect(formatPrice(2678.3, "GC", "future")).toBe("2,678.3");
  });

  it("notifies only listeners subscribed to a changed symbol", () => {
    const store = new QuoteStore();
    const apple = vi.fn();
    const nvidia = vi.fn();
    store.subscribe("AAPL", apple);
    store.subscribe("NVDA", nvidia);
    store.updateMany([quote("AAPL", 229)]);
    expect(apple).toHaveBeenCalledTimes(1);
    expect(nvidia).not.toHaveBeenCalled();
    expect(store.get("AAPL")?.quote.last).toBe(229);
  });

  it("rolls VWAP at session boundaries", () => {
    const bars = [
      { high: 12, low: 9, close: 12, volume: 2 },
      { high: 15, low: 12, close: 15, volume: 1 },
      { high: 30, low: 27, close: 30, volume: 3 },
    ];
    expect(sessionVolumeWeightedAveragePrice(bars, (index) => index < 2 ? "session-a" : "session-b"))
      .toEqual([11, 12, 29]);
  });

  it("aggregates ticks into timeframe buckets and creates a fresh boundary bar", () => {
    const aggregator = new BarAggregator();
    expect(barBucketStart("1m", 1_800)).toBe(1_800);
    expect(aggregator.update("ES", "1m", 1_800, 5000, 2)).toMatchObject({
      time: 1_800, open: 5000, high: 5000, low: 5000, close: 5000, volume: 2,
    });
    expect(aggregator.update("ES", "1m", 1_859, 5001, 3)).toMatchObject({
      time: 1_800, open: 5000, high: 5001, low: 5000, close: 5001, volume: 5,
    });
    expect(aggregator.update("ES", "1m", 1_860, 5002, 1)).toMatchObject({
      time: 1_860, open: 5002, high: 5002, low: 5002, close: 5002, volume: 1,
    });

  });

  it("supports watchlist CRUD, item edits, moves, and reorder in mock mode", async () => {
    vi.stubEnv("DATABASE_URL", "");
    globalThis.inMemoryWatchlists = undefined;
    try {
      const [core, macro] = await getWatchlists();
      const created = await createWatchlist("Research");
      const item = await addWatchlistItem(created.id, { symbol: "META", assetClass: "stock", note: "" });
      const another = await addWatchlistItem(created.id, { symbol: "AMD", assetClass: "stock", note: "" });
      await updateWatchlistItem(created.id, item.id, { note: "earnings" });
      expect((await getWatchlists()).find((list) => list.id === created.id)?.items.map((entry) => entry.id))
        .toEqual([item.id, another.id]);
      await reorderWatchlistItems(created.id, [another.id, item.id]);
      expect((await getWatchlists()).find((list) => list.id === created.id)?.items.map((entry) => entry.id))
        .toEqual([another.id, item.id]);
      await updateWatchlistItem(created.id, item.id, { watchlistId: macro!.id, note: "moved" });
      expect((await getWatchlists()).find((list) => list.id === macro!.id)?.items.at(-1)?.symbol).toBe("META");
      const renamed = await renameWatchlist(created.id, "Research 2");
      expect(renamed.name).toBe("Research 2");
      const duplicate = await duplicateWatchlist(created.id);
      expect(duplicate.items.map((entry) => entry.symbol)).toEqual(["AMD"]);
      await removeWatchlistItem(created.id, another.id);
      await deleteWatchlist(created.id);
      expect((await getWatchlists()).some((list) => list.id === created.id)).toBe(false);
      expect(core?.name).toBe("Core");
    } finally {
      vi.unstubAllEnvs();
      globalThis.inMemoryWatchlists = undefined;
    }
  });
});
