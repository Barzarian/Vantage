import { describe, expect, it } from "vitest";
import {
  calculatePortfolioPnl,
  calculatePositionPnl,
  calculateRealizedPnl,
  getContractMultiplier,
} from "../../lib/positions/pnl";

describe("position P&L", () => {
  it("calculates long and short stock unrealized and realized P&L", () => {
    expect(
      calculatePositionPnl({
        assetClass: "stock",
        quantity: 10,
        entryPrice: 100,
        markPrice: 110,
      }),
    ).toEqual({ multiplier: 1, unrealizedPnl: 100, costBasis: 1000, marketValue: 1100 });
    expect(
      calculateRealizedPnl({
        assetClass: "stock",
        quantity: -10,
        entryPrice: 100,
        exitPrice: 90,
      }),
    ).toBe(100);
  });

  it("applies the standard 100x option contract multiplier", () => {
    expect(getContractMultiplier("option")).toBe(100);
    expect(
      calculatePositionPnl({
        assetClass: "option",
        quantity: 2,
        entryPrice: 3.5,
        markPrice: 4.25,
      }).unrealizedPnl,
    ).toBe(150);
  });

  it("applies the supplied futures contract multiplier to P&L and notional", () => {
    const pnl = calculatePositionPnl({
      assetClass: "future",
      quantity: 2,
      entryPrice: 5000,
      markPrice: 5010,
      futuresMultiplier: 50,
    });

    expect(pnl).toEqual({
      multiplier: 50,
      unrealizedPnl: 1000,
      costBasis: 500000,
      marketValue: 501000,
    });
    expect(
      calculateRealizedPnl({
        assetClass: "future",
        quantity: -1,
        entryPrice: 80,
        exitPrice: 78,
        futuresMultiplier: 1000,
      }),
    ).toBe(2000);
  });

  it("requires a futures multiplier and totals mixed portfolio P&L", () => {
    expect(() =>
      calculatePositionPnl({ assetClass: "future", quantity: 1, entryPrice: 1, markPrice: 2 }),
    ).toThrow(RangeError);
    expect(
      calculatePortfolioPnl([
        { assetClass: "stock", quantity: 10, entryPrice: 100, markPrice: 105 },
        { assetClass: "option", quantity: -1, entryPrice: 2, markPrice: 1 },
        { assetClass: "future", quantity: 1, entryPrice: 4000, markPrice: 4001, futuresMultiplier: 50 },
      ]),
    ).toBe(200);
  });
});
