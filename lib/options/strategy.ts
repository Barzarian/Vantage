import { z } from "zod";
import { calculateBlackScholes, type OptionGreeks, type OptionType } from "@/lib/greeks/black-scholes";
import { formatOccSymbol } from "@/lib/greeks/occ";
import { optionExpiryTimestamp, timeToOptionExpiry } from "@/lib/greeks/expiry";
import type { OptionChainItem } from "@/lib/market-data/schemas";

export const strategyLegSchema = z.discriminatedUnion("instrument", [
  z.object({
    id: z.string().min(1),
    instrument: z.literal("option"),
    occSymbol: z.string().min(8),
    underlying: z.string().min(1),
    expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    strike: z.number().positive(),
    type: z.enum(["call", "put"]),
    side: z.enum(["long", "short"]),
    quantity: z.number().int().positive(),
    entryPrice: z.number().nonnegative(),
    impliedVolatility: z.number().positive(),
    multiplier: z.literal(100),
  }),
  z.object({
    id: z.string().min(1),
    instrument: z.literal("shares"),
    underlying: z.string().min(1),
    side: z.enum(["long", "short"]),
    quantity: z.number().int().positive(),
    entryPrice: z.number().positive(),
    multiplier: z.literal(1),
  }),
]);
export type StrategyLeg = z.infer<typeof strategyLegSchema>;

export const savedStrategySchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(64),
  legs: z.array(strategyLegSchema).max(32),
  createdAt: z.string().datetime(),
});
export type SavedStrategy = z.infer<typeof savedStrategySchema>;

export const strategyPresetSchema = z.enum([
  "Long call",
  "Long put",
  "Covered call",
  "Cash-secured put",
  "Call vertical",
  "Put vertical",
  "Straddle",
  "Strangle",
  "Iron condor",
  "Iron butterfly",
  "Calendar",
]);
export type StrategyPreset = z.infer<typeof strategyPresetSchema>;

export type PayoffPoint = { spot: number; expiryPnl: number; forwardPnl: number };
export type StrategyAnalytics = {
  netDebitCredit: number;
  maxProfit: number | "unlimited";
  maxLoss: number | "unlimited";
  breakevens: number[];
  probabilityOfProfit: number | null;
  netGreeks: Pick<OptionGreeks, "delta" | "gamma" | "theta" | "vega" | "rho">;
  payoff: PayoffPoint[];
};

export function optionLegFromChain(
  entry: OptionChainItem,
  side: "long" | "short",
  quantity = 1,
): StrategyLeg {
  return strategyLegSchema.parse({
    id: crypto.randomUUID(),
    instrument: "option",
    ...entry.contract,
    side,
    quantity,
    entryPrice: entry.quote.mark ?? entry.quote.last ?? 0,
    impliedVolatility: entry.quote.impliedVolatility ?? 0.3,
  });
}

export function createStrategyPreset(
  preset: StrategyPreset,
  chain: OptionChainItem[],
  spot: number,
  nextExpiry?: string,
): StrategyLeg[] {
  if (!chain.length || !Number.isFinite(spot) || spot <= 0) return [];
  const orderedStrikes = [...new Set(chain.map(({ contract }) => contract.strike))].sort((a, b) => a - b);
  const atmStrike = orderedStrikes.reduce((closest, strike) =>
    Math.abs(strike - spot) < Math.abs(closest - spot) ? strike : closest,
  orderedStrikes[0]!);
  const find = (strike: number, type: OptionType): OptionChainItem =>
    chain.find(({ contract }) => contract.strike === strike && contract.type === type) ??
    chain.reduce((best, entry) =>
      entry.contract.type === type && Math.abs(entry.contract.strike - strike) < Math.abs(best.contract.strike - strike)
        ? entry
        : best,
    chain.find(({ contract }) => contract.type === type)!);
  const call = (strike: number) => find(strike, "call");
  const put = (strike: number) => find(strike, "put");
  const atmIndex = orderedStrikes.indexOf(atmStrike);
  const lower1 = orderedStrikes[Math.max(0, atmIndex - 1)]!;
  const higher1 = orderedStrikes[Math.min(orderedStrikes.length - 1, atmIndex + 1)]!;
  const lower2 = orderedStrikes[Math.max(0, atmIndex - 2)]!;
  const higher2 = orderedStrikes[Math.min(orderedStrikes.length - 1, atmIndex + 2)]!;
  const long = (entry: OptionChainItem) => optionLegFromChain(entry, "long");
  const short = (entry: OptionChainItem) => optionLegFromChain(entry, "short");

  switch (preset) {
    case "Long call": return [long(call(atmStrike))];
    case "Long put": return [long(put(atmStrike))];
    case "Covered call": return [
      strategyLegSchema.parse({
        id: crypto.randomUUID(), instrument: "shares", underlying: chain[0]!.contract.underlying,
        side: "long", quantity: 100, entryPrice: spot, multiplier: 1,
      }),
      short(call(atmStrike)),
    ];
    case "Cash-secured put": return [short(put(atmStrike))];
    case "Call vertical": return [long(call(lower1)), short(call(higher1))];
    case "Put vertical": return [long(put(higher1)), short(put(lower1))];
    case "Straddle": return [long(call(atmStrike)), long(put(atmStrike))];
    case "Strangle": return [long(call(higher1)), long(put(lower1))];
    case "Iron condor": return [
      long(put(lower2)), short(put(lower1)), short(call(higher1)), long(call(higher2)),
    ];
    case "Iron butterfly": return [
      long(put(lower1)), short(put(atmStrike)), short(call(atmStrike)), long(call(higher1)),
    ];
    case "Calendar": {
      if (!nextExpiry || nextExpiry <= chain[0]!.contract.expiry) return [];
      const near = call(atmStrike);
      const longer = long(near);
      const expiry = nextExpiry;
      const occSymbol = formatOccSymbol({ ...near.contract, expiry });
      const laterQuote = calculateBlackScholes({
        type: near.contract.type,
        spot,
        strike: near.contract.strike,
        timeToExpiry: timeToOptionExpiry(expiry),
        riskFreeRate: 0.045,
        volatility: near.quote.impliedVolatility ?? 0.3,
      });
      return [
        short(near),
        strategyLegSchema.parse({
          ...longer,
          id: crypto.randomUUID(),
          occSymbol,
          expiry,
          entryPrice: laterQuote.price,
        }),
      ];
    }
  }
}

export function analyzeStrategy(
  legs: StrategyLeg[],
  spot: number,
  options: { daysForward?: number; ivShift?: number; points?: number; now?: number } = {},
): StrategyAnalytics {
  const daysForward = options.daysForward ?? 0;
  const ivShift = options.ivShift ?? 0;
  const pointCount = Math.max(101, options.points ?? 401);
  const now = options.now ?? Date.now();
  const lowSpot = Math.max(0.01, spot * 0.01);
  const highSpot = spot * 2;
  const payoff = Array.from({ length: pointCount }, (_, index) => {
    const value = lowSpot + ((highSpot - lowSpot) * index) / (pointCount - 1);
    return {
      spot: value,
      expiryPnl: strategyExpiryPnl(legs, value),
      forwardPnl: strategyPnlAt(legs, value, daysForward, ivShift, now),
    };
  });
  const expiryPnl = payoff.map((point) => point.expiryPnl);
  const highSpotSlope = legs.reduce((slope, leg) =>
    slope + sideSign(leg.side) * leg.quantity *
      (leg.instrument === "option" ? leg.type === "call" ? leg.multiplier : 0 : leg.multiplier),
  0);
  const minimum = Math.min(...expiryPnl);
  const maximum = Math.max(...expiryPnl);
  const totalEntry = legs.reduce((sum, leg) => sum + sideSign(leg.side) * leg.entryPrice * leg.quantity * leg.multiplier, 0);
  const netDebitCredit = totalEntry;
  const netGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  for (const leg of legs) {
    if (leg.instrument !== "option") continue;
    const greeks = calculateBlackScholes({
      type: leg.type,
      spot,
      strike: leg.strike,
      timeToExpiry: timeToOptionExpiry(leg.expiry, now),
      riskFreeRate: 0.045,
      volatility: Math.max(0.001, leg.impliedVolatility + ivShift),
    });
    const sign = sideSign(leg.side) * leg.quantity * leg.multiplier;
    netGreeks.delta += greeks.delta * sign;
    netGreeks.gamma += greeks.gamma * sign;
    netGreeks.theta += greeks.theta * sign;
    netGreeks.vega += greeks.vega * sign;
    netGreeks.rho += greeks.rho * sign;
  }
  return {
    netDebitCredit,
    maxProfit: highSpotSlope > 0 ? "unlimited" : maximum,
    maxLoss: highSpotSlope < 0 ? "unlimited" : minimum,
    breakevens: findBreakevens(payoff),
    probabilityOfProfit: approximateProbabilityOfProfit(legs, spot, daysForward, now),
    netGreeks,
    payoff,
  };
}

export function strategyPnlAt(
  legs: StrategyLeg[],
  spotAtEvaluation: number,
  daysForward = 0,
  ivShift = 0,
  now = Date.now(),
): number {
  return legs.reduce((total, leg) => {
    const sign = sideSign(leg.side);
    let mark: number;
    if (leg.instrument === "shares") {
      mark = spotAtEvaluation;
    } else {
      const timeToExpiry = timeToOptionExpiry(leg.expiry, now + daysForward * 86400000);
      mark = timeToExpiry <= 0
        ? intrinsic(leg.type, spotAtEvaluation, leg.strike)
        : calculateBlackScholes({
            type: leg.type,
            spot: spotAtEvaluation,
            strike: leg.strike,
            timeToExpiry,
            riskFreeRate: 0.045,
            volatility: Math.max(0.001, leg.impliedVolatility + ivShift),
          }).price;
    }
    return total + (mark - leg.entryPrice) * sign * leg.quantity * leg.multiplier;
  }, 0);
}

export function strategyExpiryPnl(legs: StrategyLeg[], spotAtExpiry: number): number {
  return legs.reduce((total, leg) => {
    const mark = leg.instrument === "shares"
      ? spotAtExpiry
      : intrinsic(leg.type, spotAtExpiry, leg.strike);
    return total + (mark - leg.entryPrice) * sideSign(leg.side) * leg.quantity * leg.multiplier;
  }, 0);
}

function findBreakevens(points: PayoffPoint[]): number[] {
  const results: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    if (previous.expiryPnl === 0) results.push(previous.spot);
    if (previous.expiryPnl * current.expiryPnl < 0) {
      const fraction = Math.abs(previous.expiryPnl) / Math.abs(current.expiryPnl - previous.expiryPnl);
      results.push(previous.spot + (current.spot - previous.spot) * fraction);
    }
  }
  const finalPoint = points.at(-1);
  if (finalPoint?.expiryPnl === 0) results.push(finalPoint.spot);
  return [...new Set(results.map((value) => Number(value.toFixed(2))))];
}

function approximateProbabilityOfProfit(legs: StrategyLeg[], spot: number, days: number, now: number): number | null {
  const expiries = legs.filter((leg) => leg.instrument === "option").map((leg) => leg.expiry);
  if (!legs.length || !expiries.length) return null;
  const latestExpiry = Math.max(...expiries.map((expiry) => optionExpiryTimestamp(expiry) * 1000));
  const time = Math.max(0, (latestExpiry - now) / (365 * 86400000));
  if (time <= 0) return strategyPnlAt(legs, spot, days, 0, now) > 0 ? 1 : 0;
  const volatility = Math.sqrt(legs.reduce((sum, leg) =>
    sum + (leg.instrument === "option" ? leg.impliedVolatility ** 2 : 0), 0) /
    Math.max(1, legs.filter((leg) => leg.instrument === "option").length));
  const sigma = Math.max(0.01, volatility * Math.sqrt(time));
  const drift = (0.045 - sigma * sigma / (2 * time)) * time;
  let profitableWeight = 0;
  let totalWeight = 0;
  const simulations = 1001;
  for (let index = 0; index < simulations; index += 1) {
    const z = -4 + (8 * index) / (simulations - 1);
    const terminalSpot = spot * Math.exp(drift + sigma * z);
    const weight = Math.exp(-0.5 * z * z);
    totalWeight += weight;
    if (strategyExpiryPnl(legs, terminalSpot) > 0) profitableWeight += weight;
  }
  return profitableWeight / totalWeight;
}

function sideSign(side: "long" | "short"): 1 | -1 {
  return side === "long" ? 1 : -1;
}

function intrinsic(type: OptionType, spot: number, strike: number): number {
  return type === "call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}
