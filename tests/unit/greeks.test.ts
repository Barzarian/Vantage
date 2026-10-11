import { describe, expect, it } from "vitest";
import { calculateBlackScholes } from "../../lib/greeks/black-scholes";

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
    expect(greeks.theta).toBeCloseTo(-6.414, 2);
    expect(greeks.vega).toBeCloseTo(37.524, 2);
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
});
