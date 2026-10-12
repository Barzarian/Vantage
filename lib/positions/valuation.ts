import { parseOccSymbol } from "@/lib/greeks/occ";
import { getFuturesRoot } from "@/lib/futures/specs";
import { priceChangeInTicks } from "@/lib/futures/curve";
import type { OptionQuote, Quote } from "@/lib/market-data/schemas";
import { fromMinorUnits, toMinorUnits, type Position } from "./model";

export type PositionMark = {
  mark: number | null;
  previousClose: number | null;
  underlyingMark?: number | null;
  optionQuote?: Pick<OptionQuote, "delta" | "gamma" | "theta" | "vega">;
  futureDaysToExpiry?: number | null;
  fxRate?: number;
  asOf?: Date;
};

export type ValuedPosition = Position & {
  mark: number | null;
  marketValue: number | null;
  baseMarketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPercent: number | null;
  dayPnl: number | null;
  ticks?: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  deltaAdjustedNotional: number | null;
  daysToExpiry: number | null;
  marginEstimate: number | null;
  isExpired: boolean;
  totalPnl: number;
};

export function quoteMark(quote: Pick<Quote, "bid" | "ask" | "last">): number | null {
  if (Number.isFinite(quote.bid) && quote.bid >= 0 && Number.isFinite(quote.ask) &&
    quote.ask >= quote.bid && (quote.bid > 0 || quote.ask > 0)) {
    return (quote.bid + quote.ask) / 2;
  }
  return Number.isFinite(quote.last) && quote.last !== 0 ? quote.last : null;
}

export function optionQuoteMark(quote: Pick<OptionQuote, "bid" | "ask" | "last">): number | null {
  if (quote.bid !== null && quote.ask !== null && quote.ask >= quote.bid && (quote.bid > 0 || quote.ask > 0)) {
    return (quote.bid + quote.ask) / 2;
  }
  return quote.last !== null && quote.last !== 0 ? quote.last : null;
}

export function valuePosition(position: Position, input: PositionMark): ValuedPosition {
  if (input.fxRate !== undefined && (!Number.isFinite(input.fxRate) || input.fxRate <= 0)) {
    throw new RangeError("FX rate must be a positive finite number.");
  }
  const asOf = input.asOf ?? new Date();
  const fxRate = input.fxRate ?? 1;
  const multiplier = position.assetClass === "option"
    ? parseOccSymbol(position.symbol).multiplier
    : position.assetClass === "future"
      ? getFuturesRoot(position.underlying).multiplier
      : 1;
  let mark = input.mark;
  let quantity = position.quantity;
  let realizedPnl = position.realizedPnl;
  let isExpired = false;
  let daysToExpiry: number | null = null;

  if (position.assetClass === "option") {
    const contract = parseOccSymbol(position.symbol);
    daysToExpiry = optionDaysToExpiry(contract.expiry, asOf);
    if (isOptionExpired(contract.expiry, asOf) && position.quantity !== 0) {
      isExpired = true;
      if (input.underlyingMark === null || input.underlyingMark === undefined) mark = null;
      else {
        const intrinsic = contract.type === "call"
          ? Math.max(0, input.underlyingMark - contract.strike)
          : Math.max(0, contract.strike - input.underlyingMark);
        const pnlCents = toMinorUnits((intrinsic - position.averageCost) * position.quantity * multiplier);
        realizedPnl += fromMinorUnits(pnlCents);
        mark = intrinsic;
        quantity = 0;
      }
    }
  } else if (position.assetClass === "future") {
    const spec = getFuturesRoot(position.underlying);
    daysToExpiry = input.futureDaysToExpiry ?? null;
    const change = mark === null || mark === undefined ? null : mark - position.averageCost;
    const ticks = change === null ? null : priceChangeInTicks(change, spec.tickSize);
    const unrealizedPnl = quantity === 0
      ? 0
      : ticks === null
      ? null
      : fromMinorUnits(toMinorUnits(ticks * spec.tickValue * position.quantity));
    const dayChange = quantity === 0
      ? 0
      : mark === null || input.previousClose === null || input.previousClose === undefined
      ? null
      : fromMinorUnits(toMinorUnits(priceChangeInTicks(mark - input.previousClose, spec.tickSize) * spec.tickValue * position.quantity));
    const marketValue = quantity === 0 ? 0 : mark === null ? null : fromMinorUnits(toMinorUnits(mark * position.quantity * spec.multiplier));
    const adjusted = expiredAdjustment(position, quantity, realizedPnl, mark, marketValue, unrealizedPnl, dayChange, fxRate);
    return {
      ...position,
      ...adjusted,
      mark,
      ticks,
      unrealizedPercent: position.costBasis === 0 || unrealizedPnl === null ? null : unrealizedPnl / Math.abs(position.costBasis) * 100,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      deltaAdjustedNotional: null,
      daysToExpiry,
      marginEstimate: fromMinorUnits(toMinorUnits(spec.approximateMargin * Math.abs(quantity))),
      isExpired,
    };
  }

  const marketValue = quantity === 0
    ? 0
    : mark === null || mark === undefined
    ? null
    : fromMinorUnits(toMinorUnits(mark * quantity * multiplier));
  let unrealizedPnl = mark === null || mark === undefined
    ? quantity === 0 ? 0 : null
    : fromMinorUnits(toMinorUnits((mark - position.averageCost) * quantity * multiplier));
  if (isExpired && quantity === 0) unrealizedPnl = 0;
  const dayPnl = quantity === 0
    ? 0
    : mark === null || mark === undefined || input.previousClose === null || input.previousClose === undefined
    ? null
    : fromMinorUnits(toMinorUnits((mark - input.previousClose) * quantity * multiplier));
  const delta = input.optionQuote?.delta == null || quantity === 0
    ? null
    : input.optionQuote.delta * quantity * multiplier;
  const gamma = input.optionQuote?.gamma == null || quantity === 0
    ? null
    : input.optionQuote.gamma * quantity * multiplier;
  const theta = input.optionQuote?.theta == null || quantity === 0
    ? null
    : input.optionQuote.theta * quantity * multiplier;
  const vega = input.optionQuote?.vega == null || quantity === 0
    ? null
    : input.optionQuote.vega * quantity * multiplier;
  const deltaAdjustedNotional = delta === null || input.underlyingMark == null || input.underlyingMark === undefined
    ? null
    : fromMinorUnits(toMinorUnits(delta * input.underlyingMark));
  const adjusted = expiredAdjustment(position, quantity, realizedPnl, mark ?? null, marketValue, unrealizedPnl, dayPnl, fxRate);
  return {
    ...position,
    ...adjusted,
    mark: mark ?? null,
    unrealizedPercent: position.costBasis === 0 || unrealizedPnl === null ? null : unrealizedPnl / Math.abs(position.costBasis) * 100,
    dayPnl,
    delta,
    gamma,
    theta,
    vega,
    deltaAdjustedNotional,
    daysToExpiry,
    marginEstimate: null,
    isExpired,
  };
}

export function quoteMarkFromStore(quote: Quote | undefined): number | null {
  return quote ? quoteMark(quote) : null;
}

export function optionDaysToExpiry(expiry: string, asOf = new Date()): number {
  const eastern = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(asOf);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(eastern.find((value) => value.type === type)!.value);
  const today = Date.UTC(part("year"), part("month") - 1, part("day"));
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - today) / 86_400_000);
}

export function isOptionExpired(expiry: string, asOf = new Date()): boolean {
  const days = optionDaysToExpiry(expiry, asOf);
  if (days < 0) return true;
  if (days > 0) return false;
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(asOf);
  const timePart = (type: Intl.DateTimeFormatPartTypes) => Number(timeParts.find((value) => value.type === type)!.value);
  return timePart("hour") > 16 || (timePart("hour") === 16 && timePart("minute") >= 0);
}

function expiredAdjustment(
  position: Position,
  quantity: number,
  realizedPnl: number,
  mark: number | null,
  marketValue: number | null,
  unrealizedPnl: number | null,
  dayPnl: number | null,
  fxRate: number,
) {
  const expiredAtIntrinsic = position.assetClass === "option" && quantity === 0 && position.quantity !== 0;
  return {
    quantity,
    realizedPnl,
    marketValue: expiredAtIntrinsic ? 0 : marketValue,
    baseMarketValue: expiredAtIntrinsic ? 0 : marketValue === null ? null : fromMinorUnits(toMinorUnits(marketValue * fxRate)),
    unrealizedPnl: expiredAtIntrinsic ? 0 : unrealizedPnl,
    dayPnl: expiredAtIntrinsic ? 0 : dayPnl,
    totalPnl: realizedPnl + (expiredAtIntrinsic ? 0 : unrealizedPnl ?? 0),
    mark,
  };
}
