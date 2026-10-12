import type { OptionChainItem, OptionQuote } from "@/lib/market-data/schemas";
import { calculateBlackScholes } from "./black-scholes";
import { solveImpliedVolatility } from "./implied-volatility";
import { timeToOptionExpiry } from "./expiry";

export function completeOptionGreeks(
  entry: OptionChainItem,
  spot: number,
  now = Date.now(),
  riskFreeRate = 0.045,
): OptionQuote {
  const { contract, quote } = entry;
  if (![quote.delta, quote.gamma, quote.theta, quote.vega].some((value) => value == null)) return quote;
  const timeToExpiry = timeToOptionExpiry(contract.expiry, now);
  const marketPrice = quote.mark ?? quote.last ?? (
    quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : null
  );
  let impliedVolatility = quote.impliedVolatility;
  if (impliedVolatility === null && marketPrice !== null) {
    const solved = solveImpliedVolatility({
      type: contract.type,
      spot,
      strike: contract.strike,
      timeToExpiry,
      riskFreeRate,
      marketPrice,
    });
    impliedVolatility = solved.ok ? solved.volatility : null;
  }
  const computed = impliedVolatility === null
    ? undefined
    : calculateBlackScholes({
        type: contract.type,
        spot,
        strike: contract.strike,
        timeToExpiry,
        riskFreeRate,
        volatility: impliedVolatility,
      });
  return {
    ...quote,
    impliedVolatility,
    delta: quote.delta ?? computed?.delta ?? null,
    gamma: quote.gamma ?? computed?.gamma ?? null,
    theta: quote.theta ?? computed?.theta ?? null,
    vega: quote.vega ?? computed?.vega ?? null,
    greeksSource: computed ? "computed" : "provider",
  };
}
