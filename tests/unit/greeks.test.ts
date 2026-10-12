import { describe, expect, it } from "vitest";
import { calculateBlackScholes } from "../../lib/greeks/black-scholes";
import { optionExpiryTimestamp, timeToOptionExpiry } from "../../lib/greeks/expiry";
import { solveImpliedVolatility } from "../../lib/greeks/implied-volatility";

describe("calculateBlackScholes", () => {
  const atmCall = {
    type: "call" as const,
    spot: 100,
    strike: 100,
    timeToExpiry: 1,
    riskFreeRate: 0.05,
    volatility: 0.2,
  };

  it("prices a one-year at-the-money call and calculates its Greeks", () => {
    const greeks = calculateBlackScholes(atmCall);

    expect(greeks.price).toBeCloseTo(10.4506, 3);
    expect(greeks.delta).toBeCloseTo(0.6368, 3);
    expect(greeks.gamma).toBeCloseTo(0.01876, 4);
    expect(greeks.theta).toBeCloseTo(-6.414 / 365, 5);
    expect(greeks.vega).toBeCloseTo(0.37524, 3);
    expect(greeks.rho).toBeCloseTo(53.232, 2);
  });

  it("returns put values and respects put-call parity", () => {
    const put = calculateBlackScholes({ ...atmCall, type: "put" });
    const call = calculateBlackScholes(atmCall);

    expect(put.price).toBeCloseTo(5.5735, 3);
    expect(put.delta).toBeCloseTo(-0.3632, 3);
    expect(call.price - put.price).toBeCloseTo(100 - 100 * Math.exp(-0.05), 5);
  });

  it("supports dividend yield and rejects invalid inputs", () => {
    const withDividend = calculateBlackScholes({ ...atmCall, dividendYield: 0.03 });
    expect(withDividend.delta).toBeLessThan(calculateBlackScholes(atmCall).delta);
    expect(() => calculateBlackScholes({ ...atmCall, volatility: 0 })).toThrow(RangeError);
    expect(() => calculateBlackScholes({ ...atmCall, spot: Number.NaN })).toThrow(RangeError);
  });

  it("solves implied volatility with Newton and respects no-arbitrage bounds", () => {
    const marketPrice = calculateBlackScholes({ ...atmCall, dividendYield: 0.02 }).price;
    const result = solveImpliedVolatility({
      type: "call",
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      dividendYield: 0.02,
      marketPrice,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.volatility).toBeCloseTo(0.2, 6);
    expect(solveImpliedVolatility({
      type: "call",
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      marketPrice: 101,
    })).toEqual({ ok: false, reason: "no-solution" });
  });

  it("uses 16:00 New York expiry across daylight-saving time and handles expiry now", () => {
    expect(new Date(optionExpiryTimestamp("2026-03-06") * 1000).toISOString())
      .toBe("2026-03-06T21:00:00.000Z");
    expect(new Date(optionExpiryTimestamp("2026-03-13") * 1000).toISOString())
      .toBe("2026-03-13T20:00:00.000Z");
    expect(timeToOptionExpiry("2026-03-13", optionExpiryTimestamp("2026-03-13") * 1000)).toBe(0);
    expect(calculateBlackScholes({ ...atmCall, timeToExpiry: 0 }).price).toBe(0);
  });
});
