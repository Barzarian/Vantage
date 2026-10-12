import { describe, expect, it } from "vitest";
import { formatOccSymbol } from "../../lib/greeks/occ";
import { foldTransactions } from "../../lib/positions/ledger";
import type { PositionTransaction } from "../../lib/positions/model";
import { isOptionExpired, optionQuoteMark, quoteMark, valuePosition } from "../../lib/positions/valuation";
import { getFuturesRoot } from "../../lib/futures/specs";

const accountId = "acct";

function trade(
  id: string,
  symbol: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
  fees = 0,
  assetClass: "equity" | "option" | "future" = "equity",
  executedAt = `2026-01-${String(Number(id) + 1).padStart(2, "0")}T15:00:00.000Z`,
): PositionTransaction {
  return {
    id,
    accountId,
    symbol,
    assetClass,
    kind: "trade",
    side,
    quantity,
    price,
    fees,
    currency: "USD",
    executedAt,
    notes: "",
  };
}

describe("transaction-sourced position ledger", () => {
  const partialLots = [
    trade("1", "ABC", "buy", 10, 100, 1),
    trade("2", "ABC", "buy", 10, 120, 2),
    trade("3", "ABC", "sell", 12, 130, 1.2),
  ];

  it("folds partial closes and includes fees in the remaining average cost and realized P&L", () => {
    const { positions, realizedEvents } = foldTransactions(partialLots, "fifo");
    expect(positions[0]).toMatchObject({
      quantity: 8,
      costBasis: 961.6,
      averageCost: 120.2,
      realizedPnl: 317.4,
    });
    expect(realizedEvents[0]?.amount).toBe(317.4);
  });

  it("uses FIFO, LIFO, and true average-cost lot accounting", () => {
    expect(foldTransactions(partialLots, "fifo").positions[0]?.realizedPnl).toBe(317.4);
    expect(foldTransactions(partialLots, "lifo").positions[0]).toMatchObject({
      quantity: 8,
      averageCost: 100.1,
      realizedPnl: 156.6,
    });
    expect(foldTransactions(partialLots, "average").positions[0]).toMatchObject({
      quantity: 8,
      averageCost: 110.15,
      realizedPnl: 237,
    });
  });

  it("supports short positions, flips through zero, and assigns transaction fees proportionally", () => {
    const { positions } = foldTransactions([
      trade("1", "ABC", "buy", 10, 100),
      trade("2", "ABC", "sell", 15, 90, 0.5),
    ]);
    expect(positions[0]).toMatchObject({
      quantity: -5,
      averageCost: 89.966,
      realizedPnl: -100.33,
    });
  });

  it("applies option contract multipliers and auto-closes expired options at intrinsic value", () => {
    const symbol = formatOccSymbol({ underlying: "SPY", expiry: "2026-10-16", strike: 100, type: "call" });
    const { positions } = foldTransactions([trade("1", symbol, "buy", 1, 2, 0, "option")]);
    const expired = valuePosition(positions[0]!, {
      mark: 4,
      previousClose: null,
      underlyingMark: 110,
      asOf: new Date("2026-10-17T16:00:00.000Z"),
    });
    expect(expired).toMatchObject({
      quantity: 0,
      mark: 10,
      marketValue: 0,
      realizedPnl: 800,
      unrealizedPnl: 0,
      totalPnl: 800,
      daysToExpiry: -1,
      isExpired: true,
    });
  });

  it("calculates futures P&L in spec ticks and estimates margin from the contract table", () => {
    const position = foldTransactions([
      trade("1", "ESZ6", "buy", 2, 5000.25, 0, "future"),
    ]).positions[0]!;
    const valued = valuePosition(position, {
      mark: 5001.25,
      previousClose: 5000.5,
    });
    const spec = getFuturesRoot("ES");
    expect(valued.ticks).toBe(4);
    expect(valued.unrealizedPnl).toBe(100);
    expect(valued.dayPnl).toBe(75);
    expect(valued.marginEstimate).toBe(spec.approximateMargin * 2);
  });

  it("uses mid then last for marks, keeps absent marks null, and expires after the option close", () => {
    expect(quoteMark({ bid: 99, ask: 101, last: 100 })).toBe(100);
    expect(quoteMark({ bid: 0, ask: 0, last: 0 })).toBeNull();
    expect(optionQuoteMark({ bid: 0, ask: 0, last: 1.25 })).toBe(1.25);
    expect(isOptionExpired("2026-10-16", new Date("2026-10-16T19:59:00.000Z"))).toBe(false);
    expect(isOptionExpired("2026-10-16", new Date("2026-10-16T20:01:00.000Z"))).toBe(true);
  });

  it("applies equity split and dividend actions at their execution points", () => {
    const { positions } = foldTransactions([
      trade("1", "ABC", "buy", 10, 100),
      {
        id: "2", accountId, symbol: "ABC", assetClass: "equity", kind: "split",
        ratioNumerator: 2, ratioDenominator: 1, executedAt: "2026-02-01T15:00:00.000Z", notes: "",
      },
      {
        id: "3", accountId, symbol: "ABC", assetClass: "equity", kind: "dividend",
        amountPerShare: 1, currency: "USD", executedAt: "2026-02-02T15:00:00.000Z", notes: "",
      },
    ]);
    expect(positions[0]).toMatchObject({ quantity: 20, averageCost: 50, realizedPnl: 20 });
  });
});
