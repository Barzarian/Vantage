import { afterEach, describe, expect, it, vi } from "vitest";
import { formatOccSymbol, parseOccSymbol } from "../../lib/greeks/occ";
import { MockMarketDataProvider } from "../../lib/market-data/mock-provider";
import { QuoteStore } from "../../lib/market-data/quote-store";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OCC option symbols", () => {
  it("formats and parses standard padded OCC symbols", () => {
    const contract = {
      underlying: "SPY",
      expiry: "2026-10-16",
      strike: 575,
      type: "call" as const,
    };
    const symbol = formatOccSymbol(contract);
    expect(symbol).toBe("SPY   261016C00575000");
    expect(parseOccSymbol(symbol)).toMatchObject({
      ...contract,
      occSymbol: symbol,
      multiplier: 100,
    });
  });

  it("rejects invalid dates and strikes", () => {
    expect(() => parseOccSymbol("SPY   261332C00575000")).toThrow(RangeError);
    expect(() => formatOccSymbol({
      underlying: "SPY",
      expiry: "2026-10-16",
      strike: Number.NaN,
      type: "put",
    })).toThrow(RangeError);
  });
});

describe("mock option chains", () => {
  it("returns seeded expiries and reproducible smile-priced chain entries", async () => {
    const provider = new MockMarketDataProvider();
    const expiries = await provider.getOptionExpiries("SPY");
    const weeklyAndMonthly = expiries.filter((expiry) => new Date(`${expiry}T00:00:00Z`).getUTCDay() === 5);
    expect(weeklyAndMonthly.length).toBeGreaterThan(8);
    const chain = await provider.getOptionChain("SPY", expiries[0]!);
    const repeat = await provider.getOptionChain("SPY", expiries[0]!);
    expect(chain).toHaveLength(98);
    expect(chain.map(({ contract, quote }) => [contract.occSymbol, quote.impliedVolatility, quote.mark]))
      .toEqual(repeat.map(({ contract, quote }) => [contract.occSymbol, quote.impliedVolatility, quote.mark]));
    expect(chain.every(({ contract, quote }) =>
      contract.multiplier === 100 && contract.occSymbol === quote.occSymbol && quote.greeksSource === "computed",
    )).toBe(true);
    const calls = chain.filter(({ contract }) => contract.type === "call");
    expect(calls[0]!.quote.impliedVolatility).toBeGreaterThan(calls[Math.floor(calls.length / 2)]!.quote.impliedVolatility!);
  });

  describe("option quote store", () => {
    it("notifies only subscribers for the changed OCC contract", async () => {
      const provider = new MockMarketDataProvider();
      const expiry = (await provider.getOptionExpiries("SPY"))[0]!;
      const [first, second] = (await provider.getOptionChain("SPY", expiry)).slice(0, 2);
      const store = new QuoteStore();
      const firstListener = vi.fn();
      const secondListener = vi.fn();
      store.subscribeOption(first!.contract.occSymbol, firstListener);
      store.subscribeOption(second!.contract.occSymbol, secondListener);
      store.updateOptions([first!.quote]);
      expect(firstListener).toHaveBeenCalledOnce();
      expect(secondListener).not.toHaveBeenCalled();
    });
  });

  it("reprices option ticks from the changing underlying", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T14:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const provider = new MockMarketDataProvider();
    const expiry = (await provider.getOptionExpiries("SPY"))[0]!;
    const contract = (await provider.getOptionChain("SPY", expiry))[60]!.contract;
    const initial = (await provider.getOptionChain("SPY", expiry)).find(
      ({ contract: entry }) => entry.occSymbol === contract.occSymbol,
    )!.quote.mark;
    const onTick = vi.fn();
    const unsubscribe = provider.subscribeOptions([contract.occSymbol], onTick);
    await vi.advanceTimersByTimeAsync(1_000);
    unsubscribe();
    expect(onTick).toHaveBeenCalled();
    expect(onTick.mock.calls[0]![0].mark).not.toBe(initial);
  });
});
