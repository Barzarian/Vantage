import { calculateBlackScholes, type BlackScholesInput, type OptionType } from "./black-scholes";

export type ImpliedVolatilityResult =
  | { ok: true; volatility: number; iterations: number; method: "newton" | "bisection" }
  | { ok: false; reason: "no-solution" | "invalid-input" };

type ImpliedVolatilityInput = Omit<BlackScholesInput, "volatility"> & {
  marketPrice: number;
  tolerance?: number;
  maxIterations?: number;
};

export function solveImpliedVolatility(input: ImpliedVolatilityInput): ImpliedVolatilityResult {
  const {
    type,
    spot,
    strike,
    timeToExpiry,
    riskFreeRate,
    dividendYield = 0,
    marketPrice,
    tolerance = 1e-8,
    maxIterations = 20,
  } = input;
  if (
    !isOptionType(type) ||
    ![spot, strike, timeToExpiry, riskFreeRate, dividendYield, marketPrice, tolerance, maxIterations].every(Number.isFinite) ||
    spot <= 0 || strike <= 0 || timeToExpiry <= 0 || marketPrice < 0 || tolerance <= 0 || maxIterations < 1
  ) return { ok: false, reason: "invalid-input" };

  const discountedSpot = spot * Math.exp(-dividendYield * timeToExpiry);
  const discountedStrike = strike * Math.exp(-riskFreeRate * timeToExpiry);
  const lowerBound = type === "call"
    ? Math.max(discountedSpot - discountedStrike, 0)
    : Math.max(discountedStrike - discountedSpot, 0);
  const upperBound = type === "call" ? discountedSpot : discountedStrike;
  if (marketPrice <= lowerBound + tolerance || marketPrice >= upperBound - tolerance) {
    return { ok: false, reason: "no-solution" };
  }

  let volatility = Math.sqrt((2 * Math.abs(Math.log(spot / strike) +
    (riskFreeRate - dividendYield) * timeToExpiry)) / timeToExpiry);
  if (!Number.isFinite(volatility) || volatility < 0.05) volatility = 0.3;
  volatility = Math.min(4, Math.max(0.01, volatility));

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const model = calculateBlackScholes({
      type, spot, strike, timeToExpiry, riskFreeRate, volatility, dividendYield,
    });
    const priceError = model.price - marketPrice;
    if (Math.abs(priceError) <= tolerance) {
      return { ok: true, volatility, iterations: iteration, method: "newton" };
    }
    const vegaPerUnit = model.vega * 100;
    if (vegaPerUnit < 1e-10) break;
    const nextVolatility = volatility - priceError / vegaPerUnit;
    if (!Number.isFinite(nextVolatility) || nextVolatility <= 0.0001 || nextVolatility >= 8) break;
    volatility = nextVolatility;
  }

  let low = 0.000001;
  let high = 8;
  const highPrice = calculateBlackScholes({
    type, spot, strike, timeToExpiry, riskFreeRate, volatility: high, dividendYield,
  }).price;
  if (highPrice < marketPrice) return { ok: false, reason: "no-solution" };
  for (let iteration = 1; iteration <= 120; iteration += 1) {
    volatility = (low + high) / 2;
    const modelPrice = calculateBlackScholes({
      type, spot, strike, timeToExpiry, riskFreeRate, volatility, dividendYield,
    }).price;
    const error = modelPrice - marketPrice;
    if (Math.abs(error) <= tolerance) {
      return { ok: true, volatility, iterations: iteration, method: "bisection" };
    }
    if (error > 0) high = volatility;
    else low = volatility;
  }
  if (high - low <= 1e-8) return { ok: true, volatility, iterations: 120, method: "bisection" };
  return { ok: false, reason: "no-solution" };
}

function isOptionType(value: string): value is OptionType {
  return value === "call" || value === "put";
}
