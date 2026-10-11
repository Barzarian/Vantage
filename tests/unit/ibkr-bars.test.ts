import { describe, expect, it } from "vitest";
import {
  BarAggregator,
  barBucketStart,
} from "../../services/ibkr-bridge/src/bar-aggregator";

describe("shared live bar aggregation", () => {
  it("aggregates open, high, low, close, and trade volume into a bar", () => {
    const aggregator = new BarAggregator();

    aggregator.update("ES", "1m", 1_800_000_000, 5000, 2);
    aggregator.update("ES", "1m", 1_800_000_020, 5003, 4);
    const bar = aggregator.update("ES", "1m", 1_800_000_050, 4998, 3);

    expect(bar).toEqual({
      time: Math.floor(1_800_000_000 / 60) * 60,
      open: 5000,
      high: 5003,
      low: 4998,
      close: 4998,
      volume: 9,
    });
    expect(aggregator.getBars("ES", "1m")).toHaveLength(1);
  });

  it("starts a new bar at timeframe boundaries without inventing missing bars", () => {
    const aggregator = new BarAggregator();

    aggregator.update("AAPL", "5m", 1_800_000_000, 100);
    aggregator.update("AAPL", "5m", 1_800_000_300, 101);

    expect(aggregator.getBars("AAPL", "5m").map((bar) => bar.close)).toEqual([100, 101]);
  });

  it("anchors weekly and monthly bars to UTC session calendar boundaries", () => {
    const friday = Date.UTC(2026, 9, 9, 15) / 1000;
    expect(new Date(barBucketStart("1w", friday) * 1000).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(new Date(barBucketStart("1M", friday) * 1000).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});
