import type { Bar } from "@/lib/market-data/schemas";
import type { ContinuousAdjustment } from "@/lib/market-data/provider";

export type ContractBarSeries = { symbol: string; bars: Bar[] };

export function buildContinuousBars(
  series: ContractBarSeries[],
  adjustment: ContinuousAdjustment,
): Bar[] {
  const ordered = series
    .map((contract) => ({ ...contract, bars: [...contract.bars].sort((a, b) => a.time - b.time) }))
    .filter((contract) => contract.bars.length > 0)
    .sort((a, b) => a.bars[0]!.time - b.bars[0]!.time);
  if (adjustment === "unadjusted") {
    return deduplicate(ordered.flatMap(({ bars }) => bars));
  }
  const offsets = new Array<number>(ordered.length).fill(0);
  const factors = new Array<number>(ordered.length).fill(1);
  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    const earlier = ordered[index]!.bars.at(-1)!;
    const later = ordered[index + 1]!.bars[0]!;
    if (adjustment === "difference") {
      offsets[index] = offsets[index + 1]! + (later.open - earlier.close);
    } else {
      const ratio = earlier.close === 0 ? 1 : later.open / earlier.close;
      factors[index] = factors[index + 1]! * ratio;
    }
  }
  const adjusted = ordered.flatMap(({ bars }, index) => bars.map((bar) => {
    if (adjustment === "difference") {
      const offset = offsets[index]!;
      return { ...bar, open: bar.open + offset, high: bar.high + offset, low: bar.low + offset, close: bar.close + offset };
    }
    const factor = factors[index]!;
    return { ...bar, open: bar.open * factor, high: bar.high * factor, low: bar.low * factor, close: bar.close * factor };
  }));
  return deduplicate(adjusted);
}

function deduplicate(bars: Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of bars) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
