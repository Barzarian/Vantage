import { describe, expect, it } from "vitest";
import {
  bollingerBands,
  exponentialMovingAverage,
  movingAverageConvergenceDivergence,
  relativeStrengthIndex,
  simpleMovingAverage,
  volumeWeightedAveragePrice,
} from "../../lib/indicators";

describe("technical indicators", () => {
  it("calculates simple and exponential moving averages with warm-up nulls", () => {
    expect(simpleMovingAverage([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(exponentialMovingAverage([1, 2, 3, 4, 5], 3)).toEqual([
      null,
      null,
      2,
      3,
      4,
    ]);
    expect(() => simpleMovingAverage([1, 2], 0)).toThrow(RangeError);
  });

  it("calculates Wilder RSI and handles flat, rising, and falling markets", () => {
    expect(relativeStrengthIndex([1, 2, 3, 4, 5], 2)).toEqual([null, null, 100, 100, 100]);
    expect(relativeStrengthIndex([5, 4, 3, 2, 1], 2)).toEqual([null, null, 0, 0, 0]);
    expect(relativeStrengthIndex([3, 3, 3, 3], 2)).toEqual([null, null, 50, 50]);
  });

  it("calculates MACD only after its slow and signal periods warm up", () => {
    const result = movingAverageConvergenceDivergence([1, 2, 3, 4, 5, 6, 7], 2, 3, 2);

    expect(result.slice(0, 3)).toEqual([null, null, null]);
    expect(result[3]).toMatchObject({ macd: 0.5, signal: 0.5, histogram: 0 });
    expect(result[4]?.histogram).toBeCloseTo(
      result[4]!.macd - result[4]!.signal,
    );
    expect(() => movingAverageConvergenceDivergence([1, 2], 3, 2, 1)).toThrow(RangeError);
  });

  it("calculates population-standard-deviation Bollinger bands", () => {
    expect(bollingerBands([1, 2, 3], 3)[2]).toEqual({
      middle: 2,
      upper: 2 + 2 * Math.sqrt(2 / 3),
      lower: 2 - 2 * Math.sqrt(2 / 3),
    });
  });

  it("calculates cumulative session VWAP and skips zero-volume prefixes", () => {
    const result = volumeWeightedAveragePrice([
      { high: 12, low: 9, close: 12, volume: 0 },
      { high: 12, low: 9, close: 12, volume: 2 },
      { high: 15, low: 12, close: 15, volume: 1 },
    ]);

    expect(result[0]).toBeNull();
    expect(result[1]).toBe(11);
    expect(result[2]).toBeCloseTo(12);
    expect(() => volumeWeightedAveragePrice([{ high: 2, low: 1, close: 2, volume: -1 }])).toThrow(
      RangeError,
    );
  });
});
