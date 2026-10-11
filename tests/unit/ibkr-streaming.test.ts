import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  LineLimitError,
  MarketDataSubscriptions,
  QuoteAccumulator,
  mapMarketDataType,
} from "../../services/ibkr-bridge/src/streaming";
import type { ResolvedContract } from "../../services/ibkr-bridge/src/contracts";

const TickType = {
  BID: 1,
  LAST: 4,
  CLOSE: 9,
  DELAYED_BID: 66,
  DELAYED_LAST: 68,
  DELAYED_ASK_SIZE: 70,
  BID_SIZE: 0,
  LAST_TIMESTAMP: 45,
} as const;

const contract: ResolvedContract = {
  conId: 265598,
  symbol: "AAPL",
  name: "Apple Inc",
  secType: "STK",
  exchange: "NASDAQ",
  primaryExchange: "NASDAQ",
  currency: "USD",
  minTick: 0.01,
};

describe("IBKR streaming quotes", () => {
  it("merges field updates and calculates change from previous close", () => {
    const accumulator = new QuoteAccumulator(contract, "realtime");
    accumulator.updatePrice(TickType.CLOSE, 100);
    accumulator.updatePrice(TickType.LAST, 103);
    accumulator.updatePrice(TickType.BID, 102.9);
    accumulator.updateSize(TickType.BID_SIZE, 12);

    expect(accumulator.snapshot()).toMatchObject({
      conId: 265598,
      symbol: "AAPL",
      last: 103,
      bid: 102.9,
      bidSize: 12,
      prevClose: 100,
      change: 3,
      changePercent: 3,
      dataType: "realtime",
    });
  });

  it("maps delayed tick fields and market-data-type events", () => {
    const accumulator = new QuoteAccumulator(contract, "realtime");

    accumulator.updatePrice(TickType.DELAYED_LAST, 101);
    expect(accumulator.snapshot()?.dataType).toBe("delayed");
    accumulator.updatePrice(TickType.DELAYED_BID, 100.9);
    accumulator.updateSize(TickType.DELAYED_ASK_SIZE, 4);
    expect(accumulator.snapshot()).toMatchObject({ last: 101, bid: 100.9, askSize: 4 });
    expect(mapMarketDataType(1)).toBe("realtime");
    expect(mapMarketDataType(2)).toBe("frozen");
    expect(mapMarketDataType(3)).toBe("delayed");
    expect(mapMarketDataType(4)).toBe("frozen");
  });

  it("uses the provider trade timestamp when a tickString timestamp is present", () => {
    const accumulator = new QuoteAccumulator(contract, "realtime");

    accumulator.updateString(TickType.LAST_TIMESTAMP, "1800000123");

    expect(accumulator.snapshot()?.updatedAt).toBe(new Date(1_800_000_123_000).toISOString());
  });

  it("ref-counts the same conId to one IBKR line and cancels after the final client leaves", () => {
    const emitter = new EventEmitter() as EventEmitter & {
      reqMktData: ReturnType<typeof vi.fn>;
      cancelMktData: ReturnType<typeof vi.fn>;
    };
    emitter.reqMktData = vi.fn();
    emitter.cancelMktData = vi.fn();
    const subscriptions = new MarketDataSubscriptions(() => emitter as never, 2);
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    const unsubscribeFirst = subscriptions.subscribe(contract, firstListener);
    const unsubscribeSecond = subscriptions.subscribe(contract, secondListener);
    expect(subscriptions.activeLines).toBe(1);
    expect(emitter.reqMktData).toHaveBeenCalledTimes(1);

    emitter.emit("tickPrice", 10000, TickType.LAST, 101, {});
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    expect(emitter.cancelMktData).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(emitter.cancelMktData).toHaveBeenCalledTimes(1);
    expect(subscriptions.activeLines).toBe(0);
    subscriptions.dispose();
  });

  it("rejects a new symbol when the configured market-data line limit is reached", () => {
    const emitter = new EventEmitter() as EventEmitter & {
      reqMktData: ReturnType<typeof vi.fn>;
      cancelMktData: ReturnType<typeof vi.fn>;
    };
    emitter.reqMktData = vi.fn();
    emitter.cancelMktData = vi.fn();
    const subscriptions = new MarketDataSubscriptions(() => emitter as never, 1);
    const release = subscriptions.subscribe(contract, vi.fn());
    expect(() =>
      subscriptions.subscribe({ ...contract, conId: 2, symbol: "MSFT" }, vi.fn()),
    ).toThrow(LineLimitError);
    release();
    subscriptions.dispose();
  });

  it("can evict the least recently used explicitly-evictable line when enabled", () => {
    const emitter = new EventEmitter() as EventEmitter & {
      reqMktData: ReturnType<typeof vi.fn>;
      cancelMktData: ReturnType<typeof vi.fn>;
    };
    emitter.reqMktData = vi.fn();
    emitter.cancelMktData = vi.fn();
    const subscriptions = new MarketDataSubscriptions(() => emitter as never, 1, "realtime", true);
    const errors: Array<{ conId?: number }> = [];
    subscriptions.onError((error) => errors.push(error));
    const releaseFirst = subscriptions.subscribe(contract, vi.fn(), undefined, "1m", true);

    subscriptions.subscribe({ ...contract, conId: 2, symbol: "MSFT" }, vi.fn());

    expect(subscriptions.activeLines).toBe(1);
    expect(emitter.cancelMktData).toHaveBeenCalledTimes(1);
    expect(errors).toContainEqual(expect.objectContaining({ conId: contract.conId }));
    releaseFirst();
    subscriptions.dispose();
  });
});
