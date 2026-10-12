export type OptionType = "call" | "put";

export type BlackScholesInput = {
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiry: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
};

export type OptionGreeks = {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
};

const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

function validateInput(input: BlackScholesInput) {
  const { spot, strike, timeToExpiry, riskFreeRate, volatility, dividendYield = 0 } = input;
  if (input.type !== "call" && input.type !== "put") {
    throw new RangeError("Option type must be call or put.");
  }
  if (![spot, strike, timeToExpiry, riskFreeRate, volatility, dividendYield].every(Number.isFinite)) {
    throw new RangeError("Black-Scholes inputs must be finite numbers.");
  }
  if (spot <= 0 || strike <= 0 || timeToExpiry < 0 || volatility <= 0) {
    throw new RangeError("Spot and strike must be positive, time to expiry nonnegative, and volatility positive.");
  }
}

function normalPdf(value: number): number {
  return Math.exp(-0.5 * value * value) / SQRT_TWO_PI;
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t) *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

export function calculateBlackScholes(input: BlackScholesInput): OptionGreeks {
  validateInput(input);
  const {
    type,
    spot,
    strike,
    timeToExpiry,
    riskFreeRate,
    volatility,
    dividendYield = 0,
  } = input;
  if (timeToExpiry < 1e-10) {
    const inTheMoney = spot === strike ? 0.5 : spot > strike ? 1 : 0;
    const call = type === "call";
    return {
      price: call ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0),
      delta: call ? inTheMoney : inTheMoney - 1,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
    };
  }
  const rootTime = Math.sqrt(timeToExpiry);
  const discountedSpot = spot * Math.exp(-dividendYield * timeToExpiry);
  const discountedStrike = strike * Math.exp(-riskFreeRate * timeToExpiry);
  const d1 =
    (Math.log(spot / strike) +
      (riskFreeRate - dividendYield + (volatility * volatility) / 2) * timeToExpiry) /
    (volatility * rootTime);
  const d2 = d1 - volatility * rootTime;
  const density = normalPdf(d1);
  const call = type === "call";
  const price =
    (call ? discountedSpot * normalCdf(d1) - discountedStrike * normalCdf(d2) :
      discountedStrike * normalCdf(-d2) - discountedSpot * normalCdf(-d1));
  const delta = call
    ? Math.exp(-dividendYield * timeToExpiry) * normalCdf(d1)
    : Math.exp(-dividendYield * timeToExpiry) * (normalCdf(d1) - 1);
  const gamma =
    (Math.exp(-dividendYield * timeToExpiry) * density) / (spot * volatility * rootTime);
  const thetaPerYear =
    (-(spot * Math.exp(-dividendYield * timeToExpiry) * density * volatility) / (2 * rootTime) +
      (call
        ? -riskFreeRate * strike * Math.exp(-riskFreeRate * timeToExpiry) * normalCdf(d2) +
          dividendYield * spot * Math.exp(-dividendYield * timeToExpiry) * normalCdf(d1)
        : riskFreeRate * strike * Math.exp(-riskFreeRate * timeToExpiry) * normalCdf(-d2) -
          dividendYield * spot * Math.exp(-dividendYield * timeToExpiry) * normalCdf(-d1)));
  const vegaPerUnitVolatility = spot * Math.exp(-dividendYield * timeToExpiry) * density * rootTime;
  const theta = thetaPerYear / 365;
  const vega = vegaPerUnitVolatility / 100;
  const rho = call
    ? strike * timeToExpiry * Math.exp(-riskFreeRate * timeToExpiry) * normalCdf(d2)
    : -strike * timeToExpiry * Math.exp(-riskFreeRate * timeToExpiry) * normalCdf(-d2);

  if (![price, delta, gamma, theta, vega, rho].every(Number.isFinite)) {
    throw new RangeError("Black-Scholes calculation produced a non-finite result.");
  }
  return { price, delta, gamma, theta, vega, rho };
}
