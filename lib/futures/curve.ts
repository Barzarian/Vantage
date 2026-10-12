import type { FuturesCurvePoint } from "@/lib/market-data/schemas";

export type CurveShape = "contango" | "backwardation" | "mixed";
export type CurveClassification = { shape: CurveShape; annualizedRollYield: number | null };

export function classifyCurve(points: FuturesCurvePoint[]): CurveClassification {
  const sorted = [...points].sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  const priced = sorted.filter((point) => point.quote.last !== null);
  if (priced.length < 2 || priced[0]!.quote.last === 0) return { shape: "mixed", annualizedRollYield: null };
  const signs = priced.slice(1).map((point, index) =>
    Math.sign(point.quote.last! - priced[index]!.quote.last!),
  );
  const shape: CurveShape = signs.every((sign) => sign >= 0) && signs.some((sign) => sign > 0)
    ? "contango"
    : signs.every((sign) => sign <= 0) && signs.some((sign) => sign < 0)
      ? "backwardation"
      : "mixed";
  const front = priced[0]!;
  const second = priced[1]!;
  const days = second.daysToExpiry - front.daysToExpiry;
  const annualizedRollYield = days > 0
    ? ((front.quote.last! - second.quote.last!) / front.quote.last!) * (365 / days)
    : null;
  return { shape, annualizedRollYield };
}

export function calendarSpread(front: number, next: number): { value: number; percent: number } {
  if (!Number.isFinite(front) || !Number.isFinite(next) || front === 0) {
    throw new RangeError("Calendar spread requires finite prices and a non-zero front price.");
  }
  const value = front - next;
  return { value, percent: (value / front) * 100 };
}

export function roundToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) {
    throw new RangeError("Price and tick size must be finite, with tick size greater than zero.");
  }
  const precision = Math.min(12, Math.max(0, (String(tickSize).split(".")[1] ?? "").length));
  return Number((Math.round(price / tickSize) * tickSize).toFixed(precision));
}

export function priceChangeInTicks(change: number, tickSize: number): number {
  if (!Number.isFinite(change) || !Number.isFinite(tickSize) || tickSize <= 0) {
    throw new RangeError("Price change and tick size must be finite, with tick size greater than zero.");
  }
  return change / tickSize;
}

export function dollarsPerContract(change: number, multiplier: number): number {
  if (!Number.isFinite(change) || !Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RangeError("Price change and multiplier must be finite, with multiplier greater than zero.");
  }
  return change * multiplier;
}
