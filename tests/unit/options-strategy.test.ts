import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateBlackScholes } from "../../lib/greeks/black-scholes";
import { timeToOptionExpiry } from "../../lib/greeks/expiry";
import { MockMarketDataProvider } from "../../lib/market-data/mock-provider";
import {
  analyzeStrategy,
  createStrategyPreset,
  optionLegFromChain,
  strategyExpiryPnl,
  type StrategyPreset,
} from "../../lib/options/strategy";
import { deleteSavedStrategy, listSavedStrategies, saveStrategy } from "../../lib/options/strategies-service";

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.inMemorySavedStrategies = undefined;
});

describe("option strategy analytics", () => {
  it("builds each supported preset with the expected legs", async () => {
    const provider = new MockMarketDataProvider();
    const expiries = await provider.getOptionExpiries("SPY");
    const chain = await provider.getOptionChain("SPY", expiries[0]!);
    const expectedLegs: Record<StrategyPreset, number> = {
      "Long call": 1,
      "Long put": 1,
      "Covered call": 2,
      "Cash-secured put": 1,
      "Call vertical": 2,
      "Put vertical": 2,
      Straddle: 2,
      Strangle: 2,
      "Iron condor": 4,
      "Iron butterfly": 4,
      Calendar: 2,
    };
    for (const [preset, count] of Object.entries(expectedLegs) as [StrategyPreset, number][]) {
      expect(createStrategyPreset(preset, chain, 573.42, expiries[1])).toHaveLength(count);
    }
  });

  it("computes expiry breakevens and correctly classifies unlimited loss", async () => {
    const provider = new MockMarketDataProvider();
    const expiry = (await provider.getOptionExpiries("SPY"))[0]!;
    const chain = await provider.getOptionChain("SPY", expiry);
    const longCall = createStrategyPreset("Long call", chain, 573.42)[0]!;
    if (longCall.instrument !== "option") throw new Error("Expected an option leg.");
    const longCallStats = analyzeStrategy([longCall], 573.42);
    expect(longCallStats.maxProfit).toBe("unlimited");
    expect(longCallStats.maxLoss).toBeCloseTo(-longCall.entryPrice * 100, 1);
    expect(longCallStats.breakevens[0]).toBeCloseTo(longCall.strike + longCall.entryPrice, 1);

    const shortCall = { ...longCall, id: "short-call", side: "short" as const };
    expect(analyzeStrategy([shortCall], 573.42).maxLoss).toBe("unlimited");

    const coveredCall = createStrategyPreset("Covered call", chain, 573.42);
    expect(analyzeStrategy(coveredCall, 573.42).maxProfit).not.toBe("unlimited");
    expect(analyzeStrategy(coveredCall, 573.42).maxLoss).not.toBe("unlimited");
  });

  it("applies the 100x multiplier to net Greeks and debit/credit", async () => {
    const provider = new MockMarketDataProvider();
    const expiry = (await provider.getOptionExpiries("SPY"))[0]!;
    const chain = await provider.getOptionChain("SPY", expiry);
    const entry = chain.find(({ contract }) => contract.type === "call")!;
    const leg = optionLegFromChain(entry, "long");
    if (leg.instrument !== "option") throw new Error("Expected an option leg.");
    const result = analyzeStrategy([leg], 573.42);
    const greeks = calculateBlackScholes({
      type: leg.type,
      spot: 573.42,
      strike: leg.strike,
      timeToExpiry: timeToOptionExpiry(expiry),
      riskFreeRate: 0.045,
      volatility: leg.impliedVolatility,
    });
    expect(result.netGreeks.delta).toBeCloseTo(greeks.delta * 100, 3);
    expect(result.netGreeks.vega).toBeCloseTo(greeks.vega * 100, 3);
    expect(result.netDebitCredit).toBeCloseTo(leg.entryPrice * 100, 4);
    expect(strategyExpiryPnl([leg], 0)).toBeCloseTo(-leg.entryPrice * 100, 5);
  });
});

describe("saved strategies mock persistence", () => {
  it("persists validated strategy legs across API list reads", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const strategy = await saveStrategy("Test spread", [{
      id: "leg-1",
      instrument: "option",
      occSymbol: "SPY   261016C00575000",
      underlying: "SPY",
      expiry: "2026-10-16",
      strike: 575,
      type: "call",
      side: "long",
      quantity: 1,
      entryPrice: 4.25,
      impliedVolatility: 0.2,
      multiplier: 100,
    }]);
    expect((await listSavedStrategies()).find(({ id }) => id === strategy.id)?.legs).toHaveLength(1);
    await deleteSavedStrategy(strategy.id);
    expect(await listSavedStrategies()).toHaveLength(0);
  });
});
