import { describe, expect, it, vi } from "vitest";
import { QuoteStore } from "../../lib/market-data/quote-store";
import type { OptionQuote, Quote } from "../../lib/market-data/schemas";

function quote(last: number): Quote {
  return {
    symbol: "AAPL",
    name: "Apple",
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
    prevClose: 99,
    updatedAt: new Date("2026-01-01T12:00:00.000Z").toISOString(),
  };
}

function optionQuote(last: number): OptionQuote {
  return {
    occSymbol: "AAPL  260116C00100000",
    underlying: "AAPL",
    bid: last - 0.01,
    ask: last + 0.01,
    last,
    mark: last,
    volume: 100,
    openInterest: 1000,
    impliedVolatility: 0.2,
    delta: 0.5,
    gamma: 0.1,
    theta: -0.02,
    vega: 0.1,
    greeksSource: "provider",
    updatedAt: new Date("2026-01-01T12:00:00.000Z").toISOString(),
  };
}

describe("positions quote selectors", () => {
  it("publishes quote revisions and up/down tick flashes to only the symbol selector", () => {
    const store = new QuoteStore();
    const aapl = vi.fn();
    const msft = vi.fn();
    store.subscribe("AAPL", aapl);
    store.subscribe("MSFT", msft);
    store.update(quote(100));
    store.update(quote(101));
    expect(store.get("AAPL")).toMatchObject({ revision: 2, flash: "up" });
    store.update(quote(99));
    expect(store.get("AAPL")).toMatchObject({ revision: 3, flash: "down" });
    expect(aapl).toHaveBeenCalledTimes(3);
    expect(msft).not.toHaveBeenCalled();
  });

  it("publishes independent option-contract tick revisions", () => {
    const store = new QuoteStore();
    const optionListener = vi.fn();
    store.subscribeOption("AAPL  260116C00100000", optionListener);
    store.updateOptions([optionQuote(2)]);
    store.updateOptions([optionQuote(2.25)]);
    expect(store.getOption("AAPL  260116C00100000")).toMatchObject({ revision: 2, flash: "up" });
    expect(optionListener).toHaveBeenCalledTimes(2);
  });
});
