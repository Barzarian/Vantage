export type AggregateTimeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1M";
export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const FIXED_SECONDS: Partial<Record<AggregateTimeframe, number>> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};
export function barBucketStart(timeframe: AggregateTimeframe, epochSeconds: number): number {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) {
    throw new RangeError("Bar timestamps must be positive epoch seconds.");
  }
  const interval = FIXED_SECONDS[timeframe];
  if (interval) return Math.floor(epochSeconds / interval) * interval;
  const date = new Date(epochSeconds * 1000);
  if (timeframe === "1w") {
    const weekday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - weekday);
    date.setUTCHours(0, 0, 0, 0);
    return Math.floor(date.getTime() / 1000);
  }
  if (timeframe === "1M") {
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
    return Math.floor(date.getTime() / 1000);
  }
  throw new RangeError(`Unsupported bar timeframe: ${timeframe}`);
}

export class BarAggregator {
  private readonly bars = new Map<string, Bar[]>();

  update(
    symbol: string,
    timeframe: AggregateTimeframe,
    epochSeconds: number,
    price: number,
    volume = 0,
  ): Bar {
    if (!symbol.trim() || !Number.isFinite(price) || price < 0 || !Number.isFinite(volume) || volume < 0) {
      throw new RangeError("Bar updates require a symbol, non-negative finite price, and volume.");
    }
    const key = `${symbol}:${timeframe}`;
    const bucket = barBucketStart(timeframe, epochSeconds);
    const history = this.bars.get(key) ?? [];
    let bar = history.at(-1);
    if (!bar || bar.time !== bucket) {
      bar = { time: bucket, open: price, high: price, low: price, close: price, volume: 0 };
      history.push(bar);
      this.bars.set(key, history);
      if (history.length > 10_000) history.shift();
    }
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
    bar.volume += volume;
    return { ...bar };
  }

  getBars(symbol: string, timeframe: AggregateTimeframe): Bar[] {
    return (this.bars.get(`${symbol}:${timeframe}`) ?? []).map((bar) => ({ ...bar }));
  }

  clear(symbol?: string): void {
    if (!symbol) {
      this.bars.clear();
      return;
    }
    for (const key of this.bars.keys()) {
      if (key.startsWith(`${symbol}:`)) this.bars.delete(key);
    }
  }
}
