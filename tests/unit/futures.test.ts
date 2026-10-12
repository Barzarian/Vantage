import { describe, expect, it, vi } from "vitest";
import {
  buildFuturesContracts,
  formatFuturesSymbol,
  parseFuturesSymbol,
  resolveFrontAndNext,
  resolveFrontIndex,
} from "../../lib/futures/contracts";
import { buildContinuousBars } from "../../lib/futures/continuous";
import { calendarSpread, classifyCurve, dollarsPerContract, priceChangeInTicks, roundToTick } from "../../lib/futures/curve";
import { getFuturesRoot } from "../../lib/futures/specs";
import { futuresSessionStatus, futuresTradeDate, isFuturesHoliday } from "../../lib/futures/sessions";
import { MockMarketDataProvider } from "../../lib/market-data/mock-provider";
import { QuoteStore } from "../../lib/market-data/quote-store";
import type { Bar, FuturesCurvePoint } from "../../lib/market-data/schemas";

const knownGapFixture = [
  { symbol: "ESH6", bars: [bar(1, 99, 100), bar(2, 100, 100)] },
  { symbol: "ESM6", bars: [bar(3, 110, 111), bar(4, 111, 112)] },
];

function bar(time: number, open: number, close: number): Bar {
  return { time, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 10 };
}

function point(symbol: string, days: number, last: number, index: number): FuturesCurvePoint {
  return {
    contract: {
      symbol,
      root: "ES",
      monthCode: index === 0 ? "H" : "M",
      year: 2026,
      expiry: `2026-0${index + 3}-20`,
      lastTradeDate: `2026-0${index + 3}-17`,
      firstNoticeDate: null,
      isFront: index === 0,
    },
    quote: {
      symbol,
      last,
      bid: last - 0.25,
      ask: last + 0.25,
      settle: last,
      prevSettle: last,
      volume: 100,
      openInterest: 200,
      change: 0,
      lastUpdate: new Date("2026-01-01T00:00:00Z").toISOString(),
    },
    daysToExpiry: days,
    daysToFirstNotice: null,
  };
}

describe("futures month-code contracts", () => {
  it("formats and parses one- and two-digit years", () => {
    expect(formatFuturesSymbol("ES", "Z", 2026)).toBe("ESZ6");
    expect(formatFuturesSymbol("ES", "Z", 2026, 2)).toBe("ESZ26");
    expect(parseFuturesSymbol("ESZ6", new Date("2026-01-01T00:00:00Z"))).toEqual({
      root: "ES", monthCode: "Z", year: 2026,
    });
    expect(parseFuturesSymbol("ESZ26", new Date("2026-01-01T00:00:00Z")).year).toBe(2026);
    expect(parseFuturesSymbol("ESZ25", new Date("2026-01-01T00:00:00Z")).year).toBe(2025);
  });

  it("rolls a one-digit year into the next decade", () => {
    expect(parseFuturesSymbol("ESZ6", new Date("2029-01-01T00:00:00Z")).year).toBe(2036);
    expect(parseFuturesSymbol("ESZ6", new Date("2039-01-01T00:00:00Z")).year).toBe(2046);
  });

  it("resolves front and next around the default roll window and explicit rules", () => {
    const root = getFuturesRoot("ES");
    const contracts = buildFuturesContracts(root, new Date("2026-03-01T00:00:00Z"), 8);
    const beforeRoll = resolveFrontAndNext(contracts, root, new Date("2026-03-10T00:00:00Z"));
    expect(beforeRoll.front.symbol).toBe("ESH6");
    expect(beforeRoll.next?.symbol).toBe("ESM6");

    const afterRoll = resolveFrontAndNext(contracts, root, new Date("2026-03-14T00:00:00Z"));
    expect(afterRoll.front.symbol).toBe("ESM6");
    expect(resolveFrontIndex(contracts, root, new Date("2026-03-10T00:00:00Z"), { type: "volume-crossover" }, [100, 120])).toBe(1);
    expect(resolveFrontIndex(contracts, root, new Date("2026-03-10T00:00:00Z"), { type: "open-interest-crossover" }, undefined, [100, 120])).toBe(1);
  });
});

describe("continuous futures adjustment", () => {
  it("splices raw prices with an unadjusted gap", () => {
    const bars = buildContinuousBars(knownGapFixture, "unadjusted");
    expect(bars.map(({ close }) => close)).toEqual([100, 100, 111, 112]);
  });

  it("back-adjusts difference and ratio series across the known roll gap", () => {
    const difference = buildContinuousBars(knownGapFixture, "difference");
    expect(difference.slice(0, 2).map(({ close }) => close)).toEqual([110, 110]);
    expect(difference[0]!.open).toBe(109);
    const ratio = buildContinuousBars(knownGapFixture, "ratio");
    expect(ratio[0]!.close).toBeCloseTo(110);
    expect(ratio[1]!.close).toBeCloseTo(110);
  });
});

describe("futures curve, spread, and tick math", () => {
  it("classifies contango, backwardation, and computes annualized roll yield", () => {
    const contango = [point("ESH6", 30, 100, 0), point("ESM6", 90, 102, 1)];
    expect(classifyCurve(contango).shape).toBe("contango");
    expect(classifyCurve([point("CLX6", 30, 75, 0), point("CLZ6", 90, 72, 1)]).shape).toBe("backwardation");
    expect(classifyCurve([point("ESH6", 30, 100, 0), point("ESM6", 90, 102, 1)]).annualizedRollYield).toBeCloseTo(-0.1217, 3);
    expect(calendarSpread(100, 102)).toEqual({ value: -2, percent: -2 });
  });

  describe("futures sessions and trade dates", () => {
    it("handles nearly-24-hour sessions, maintenance, weekends, and listed holidays", () => {
      const es = getFuturesRoot("ES");
      expect(futuresSessionStatus(es, new Date("2026-10-11T22:30:00Z"))).toBe("open");
      expect(futuresSessionStatus(es, new Date("2026-10-12T21:30:00Z"))).toBe("maintenance break");
      expect(futuresSessionStatus(es, new Date("2026-10-10T16:00:00Z"))).toBe("closed");
      expect(isFuturesHoliday("2026-11-26")).toBe(true);
      expect(futuresSessionStatus(es, new Date("2026-11-26T15:00:00Z"))).toBe("closed");
    });

    describe("contract-keyed futures quote selectors", () => {
      it("notifies only the contract whose tick changed", () => {
        const store = new QuoteStore();
        const esListener = vi.fn();
        const nqListener = vi.fn();
        store.subscribeFutures("ESZ6", esListener);
        store.subscribeFutures("NQZ6", nqListener);
        store.updateMany([futureTick("ESZ6"), futureTick("NQZ6")]);
        esListener.mockClear();
        nqListener.mockClear();
        store.updateMany([futureTick("ESZ6", 5837)]);
        expect(esListener).toHaveBeenCalledTimes(1);
        expect(nqListener).not.toHaveBeenCalled();
        expect(store.getFutures("ESZ6")?.quote.last).toBe(5837);
      });
    });

    function futureTick(symbol: string, last = 5836.25) {
      return {
        symbol,
        name: symbol,
        type: "future" as const,
        last,
        change: 0.25,
        changePercent: 0.01,
        bid: last - 0.25,
        ask: last + 0.25,
        volume: 1000,
        openInterest: 5000,
        settle: last - 0.25,
        prevSettle: last - 0.25,
        dayLow: last - 2,
        dayHigh: last + 2,
        weekLow: last - 20,
        weekHigh: last + 20,
        updatedAt: new Date().toISOString(),
      };
    }

    it("rolls the futures trade date at the ET session open", () => {
      const es = getFuturesRoot("ES");
      expect(futuresTradeDate(es, new Date("2026-10-12T21:30:00Z"))).toBe("2026-10-12");
      expect(futuresTradeDate(es, new Date("2026-10-12T22:30:00Z"))).toBe("2026-10-13");
      expect(futuresTradeDate(es, new Date("2026-10-11T22:30:00Z"))).toBe("2026-10-12");
      expect(futuresTradeDate(es, new Date("2026-10-17T16:00:00Z"))).toBe("2026-10-19");
      expect(futuresTradeDate(es, new Date("2026-10-16T23:30:00Z"))).toBe("2026-10-19");
    });
  });

  it("rounds prices to tick and applies product-specific dollar multipliers", () => {
    expect(roundToTick(5836.37, 0.25)).toBe(5836.25);
    expect(priceChangeInTicks(0.5, 0.25)).toBe(2);
    expect(dollarsPerContract(1, getFuturesRoot("ES").multiplier)).toBe(50);
    expect(dollarsPerContract(1, getFuturesRoot("CL").multiplier)).toBe(1_000);
    expect(dollarsPerContract(1, getFuturesRoot("GC").multiplier)).toBe(100);
    expect(getFuturesRoot("ES").tickSize * getFuturesRoot("ES").multiplier).toBe(getFuturesRoot("ES").tickValue);
  });

  it("provides seeded contango and backwardation curves with complete quote fields", async () => {
    const provider = new MockMarketDataProvider();
    const crudeCurve = await provider.getFuturesCurve("CL");
    const goldCurve = await provider.getFuturesCurve("GC");
    expect(classifyCurve(crudeCurve).shape).toBe("backwardation");
    expect(classifyCurve(goldCurve).shape).toBe("contango");
    expect(crudeCurve.every(({ quote }) => quote.last !== null && quote.openInterest !== null)).toBe(true);
  });
});
