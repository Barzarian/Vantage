import { setTimeout as sleep } from "node:timers/promises";
import { daysToExpiry, parseFuturesSymbol } from "@/lib/futures/contracts";
import { getFuturesRoot } from "@/lib/futures/specs";
import { parseOccSymbol } from "@/lib/greeks/occ";
import {
  exponentialMovingAverage,
  movingAverageConvergenceDivergence,
  relativeStrengthIndex,
  sessionVolumeWeightedAveragePrice,
  simpleMovingAverage,
} from "@/lib/indicators";
import { getMarketDataProvider } from "@/lib/market-data";
import type { Bar, OptionQuote, Quote } from "@/lib/market-data/schemas";
import type { MarketDataProvider } from "@/lib/market-data/provider";
import { getDatabase } from "@/db/client";
import { foldTransactions } from "@/lib/positions/ledger";
import {
  listActiveAlertsForWorker,
  listRecentAlertEventsForWorker,
  evaluateAndRecordAlert,
} from "@/lib/alerts/service";
import { acceptsMarketUpdate, type AlertMetrics } from "@/lib/alerts/evaluator";
import { deliverAlertEvent } from "@/lib/alerts/delivery";
import type { Alert, AlertCondition, AlertEvent, AlertLeafCondition } from "@/lib/alerts/model";
import { optionQuoteMark, quoteMark, valuePosition } from "@/lib/positions/valuation";
import { getPositionsData } from "@/lib/positions/service";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to run the alert worker.");
if (!getDatabase()) throw new Error("Alert worker database initialization failed.");

const provider = getMarketDataProvider();
let activeAlerts: Alert[] = [];
let unsubscribeMarket: (() => void) | undefined;
let unsubscribeOptions: (() => void) | undefined;
let subscriptionKey = "";
let stopping = false;
const priorMarketValues = new Map<string, number>();
const inFlight = new Set<string>();
const lastIndicatorBucket = new Map<string, number>();
const deliveryInFlight = new Set<string>();

async function run(): Promise<void> {
  console.info("[alerts:worker] Starting market alert evaluator.");
  await refreshSubscriptions();
  const refreshTimer = setInterval(() => void refreshSubscriptions(), 10_000);
  const portfolioTimer = setInterval(() => void evaluatePortfolioAlerts(), 15_000);
  const deliveryTimer = setInterval(() => void retryUndeliveredEvents(), 15_000);
  while (!stopping) {
    await sleep(1000);
  }
  clearInterval(refreshTimer);
  clearInterval(portfolioTimer);
  clearInterval(deliveryTimer);
  unsubscribeMarket?.();
  unsubscribeOptions?.();
  console.info("[alerts:worker] Stopped.");
}

async function retryUndeliveredEvents(): Promise<void> {
  try {
    const events = await listRecentAlertEventsForWorker();
    for (const event of events) {
      const result = await deliverOnce(event.userId, event);
      if (Object.values(result).some((entry) => entry.status === "failed")) {
        console.warn(`[alerts:worker] One or more channels remain undelivered for event ${event.id}.`);
      }
    }
  } catch (error) {
    console.error(`[alerts:worker] Could not retry pending alert deliveries: ${errorMessage(error)}`);
  }
}

async function deliverOnce(userId: string, event: AlertEvent) {
  if (deliveryInFlight.has(event.id)) return event.deliveryResults;
  deliveryInFlight.add(event.id);
  try {
    return await deliverAlertEvent(userId, event);
  } finally {
    deliveryInFlight.delete(event.id);
  }
}

async function refreshSubscriptions(): Promise<void> {
  try {
    activeAlerts = await listActiveAlertsForWorker();
    const marketSymbols = [...new Set(activeAlerts
      .filter((alert) => alert.assetClass !== "option" && alert.assetClass !== "portfolio")
      .map((alert) => alert.symbol))].sort();
    const optionSymbols = [...new Set(activeAlerts
      .filter((alert) => alert.assetClass === "option")
      .map((alert) => parseOccSymbol(alert.symbol).occSymbol))].sort();
    const nextKey = `${marketSymbols.join(",")}|${optionSymbols.join(",")}`;
    if (nextKey === subscriptionKey) return;
    unsubscribeMarket?.();
    unsubscribeOptions?.();
    unsubscribeMarket = undefined;
    unsubscribeOptions = undefined;
    subscriptionKey = nextKey;
    if (marketSymbols.length) {
      unsubscribeMarket = provider.subscribe(marketSymbols, (tick) => {
        void handleQuoteTick(tick);
      }, undefined, undefined, (status, event) => {
        if (event === "error" || status.state === "disconnected") {
          console.error(`[alerts:worker] Market stream ${status.state ?? "error"}: ${status.message ?? status.code ?? "unknown error"}`);
        }
      }, false);
    }
    if (optionSymbols.length) {
      unsubscribeOptions = provider.subscribeOptions(optionSymbols, (tick) => {
        void handleOptionTick(tick);
      });
    }
    console.info(`[alerts:worker] Subscribed to ${marketSymbols.length} symbols and ${optionSymbols.length} options.`);
  } catch (error) {
    console.error(`[alerts:worker] Could not refresh subscriptions: ${errorMessage(error)}`);
  }
}

async function handleQuoteTick(tick: Quote): Promise<void> {
  const matching = activeAlerts.filter((alert) => alert.symbol === tick.symbol.toUpperCase());
  if (!matching.length) return;
  const currentMark = quoteMark(tick);
  const previousMark = priorMarketValues.get(tick.symbol.toUpperCase());
  const accepted = matching.filter((alert) => acceptsMarketUpdate({
    value: currentMark,
    updatedAt: tick.updatedAt,
    previousValue: previousMark,
    maxJumpPercent: alert.maxJumpPercent,
  }));
  if (!accepted.length) {
    console.warn(`[alerts:worker] Ignored stale, invalid, or discontinuous tick for ${tick.symbol}.`);
    return;
  }
  if (currentMark !== null) priorMarketValues.set(tick.symbol.toUpperCase(), currentMark);
  for (const alert of accepted) {
    if (!shouldEvaluateForTick(alert, tick.updatedAt)) continue;
    const key = `alert:${alert.id}`;
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    void evaluateMarketAlert(alert, tick, null).finally(() => inFlight.delete(key));
  }
}

async function handleOptionTick(tick: OptionQuote): Promise<void> {
  const matching = activeAlerts.filter((alert) => alert.symbol === tick.occSymbol);
  if (!matching.length) return;
  const mark = tick.mark ?? (tick.bid !== null && tick.ask !== null
    ? (tick.bid + tick.ask) / 2
    : tick.last);
  const previousMark = priorMarketValues.get(tick.occSymbol);
  const accepted = matching.filter((alert) => acceptsMarketUpdate({
    value: mark,
    updatedAt: tick.updatedAt,
    previousValue: previousMark,
    maxJumpPercent: alert.maxJumpPercent,
  }));
  if (!accepted.length) {
    console.warn(`[alerts:worker] Ignored stale, invalid, or discontinuous option tick for ${tick.occSymbol}.`);
    return;
  }
  if (mark !== null) priorMarketValues.set(tick.occSymbol, mark);
  const quote = optionQuoteAsQuote(tick, mark);
  for (const alert of accepted) {
    if (!shouldEvaluateForTick(alert, tick.updatedAt)) continue;
    const key = `alert:${alert.id}`;
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    void evaluateMarketAlert(alert, quote, tick).finally(() => inFlight.delete(key));
  }
}

async function evaluateMarketAlert(alert: Alert, quote: Quote, option: OptionQuote | null): Promise<void> {
  if (alert.onlyRegularHours && !isRegularUsSession(new Date())) return;
  try {
    const metrics = await buildMarketMetrics(alert, quote, option);
    const { event } = await evaluateAndRecordAlert(alert.userId, alert.id, metrics);
    if (event) await deliverOnce(alert.userId, event);
  } catch (error) {
    console.error(`[alerts:worker] Evaluation failed for ${alert.id}: ${errorMessage(error)}`);
  }
}

async function buildMarketMetrics(alert: Alert, quote: Quote, option: OptionQuote | null): Promise<AlertMetrics> {
  const mark = option ? optionQuoteMark(option) : quoteMark(quote);
  const metrics: AlertMetrics = {
    "price.last": quote.last > 0 ? quote.last : null,
    "price.mid": option ? mark : Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.ask >= quote.bid
      ? (quote.bid + quote.ask) / 2 : mark,
    "price.bid": option ? option.bid : quote.bid,
    "price.ask": option ? option.ask : quote.ask,
    "percent-change": quote.changePercent,
    "option.mid": option ? mark : null,
    "option.impliedVolatility": option?.impliedVolatility ?? null,
    "option.delta": option?.delta ?? null,
    "option.gamma": option?.gamma ?? null,
    "option.theta": option?.theta ?? null,
    "option.vega": option?.vega ?? null,
    "option.volume": option?.volume ?? null,
    "option.openInterest": option?.openInterest ?? null,
  };
  const leaves = leavesOf(alert.condition);
  const needsBars = leaves.some((condition) =>
    condition.type === "indicator" || condition.type === "volume-spike" || condition.type === "percent-change");
  if (needsBars) {
    const maxLookback = Math.max(60, ...leaves.map((condition) =>
      condition.type === "percent-change" ? condition.windowMinutes + 2 :
      condition.type === "volume-spike" ? condition.lookbackMinutes + 2 :
      condition.type === "indicator" ? condition.period * 3 : 0,
    ));
    const now = Math.floor(Date.now() / 1000);
    const bars = await provider.getBars(alert.assetClass === "option" ? parseOccSymbol(alert.symbol).underlying : alert.symbol, "1m", {
      from: now - maxLookback * 60,
      to: now,
      limit: Math.min(1500, maxLookback + 5),
    });
    setHistoryMetrics(metrics, leaves, bars, mark, alert.assetClass !== "option", Date.parse(quote.updatedAt) / 1000);
  }
  if (alert.assetClass === "future") {
    Object.assign(metrics, await futuresMetrics(alert, quote, provider));
  }
  return metrics;
}

function setHistoryMetrics(
  metrics: AlertMetrics,
  conditions: AlertLeafCondition[],
  bars: Bar[],
  mark: number | null,
  allowPercentChange: boolean,
  metricTime: number,
): void {
  for (const condition of conditions) {
    if (condition.type === "percent-change") {
      if (!allowPercentChange) {
        metrics[`percent-change.${condition.windowMinutes}`] = null;
        continue;
      }
      const target = metricTime - condition.windowMinutes * 60;
      const baseline = [...bars].reverse().find((bar) => bar.time <= target);
      const current = mark;
      metrics[`percent-change.${condition.windowMinutes}`] = baseline &&
        target - baseline.time <= 180 && current !== null && current !== undefined
        ? (current / baseline.close - 1) * 100
        : null;
    } else if (condition.type === "volume-spike") {
      const endTime = Math.floor(metricTime / 60) * 60;
      const currentBar = bars.find((bar) => bar.time === endTime);
      const window = bars.filter((bar) =>
        bar.time < endTime && bar.time >= endTime - condition.lookbackMinutes * 60,
      ).map((bar) => bar.volume);
      const average = window.length ? window.reduce((sum, value) => sum + value, 0) / window.length : null;
      metrics[`volume-spike.${condition.lookbackMinutes}`] = average && currentBar && metricTime - currentBar.time < 120
        ? currentBar.volume / average
        : null;
    } else if (condition.type === "indicator") {
      const currentMinute = Math.floor(metricTime / 60) * 60;
      let indicatorBars = bars.filter((bar) => condition.intrabar
        ? bar.time <= currentMinute
        : bar.time < currentMinute);
      if (condition.intrabar && mark !== null && mark > 0) {
        const last = indicatorBars.at(-1);
        if (last?.time === currentMinute) {
          indicatorBars = indicatorBars.slice(0, -1).concat({
            ...last,
            close: mark,
            high: Math.max(last.high, mark),
            low: Math.min(last.low, mark),
          });
        } else {
          indicatorBars = indicatorBars.concat({
            time: currentMinute,
            open: mark,
            high: mark,
            low: mark,
            close: mark,
            volume: 0,
          });
        }
      }
      const closes = indicatorBars.map((bar) => bar.close);
      let value: number | null = null;
      if (condition.indicator === "rsi") {
        value = relativeStrengthIndex(closes, condition.period).at(-1) ?? null;
      } else if (condition.indicator === "sma") {
        value = simpleMovingAverage(closes, condition.period).at(-1) ?? null;
      } else if (condition.indicator === "ema") {
        value = exponentialMovingAverage(closes, condition.period).at(-1) ?? null;
      } else if (condition.indicator === "macd") {
        value = movingAverageConvergenceDivergence(closes, 12, 26, condition.period).at(-1)?.macd ?? null;
      } else {
        const sessionDate = (index: number) => new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(indicatorBars[index]!.time * 1000));
        value = sessionVolumeWeightedAveragePrice(indicatorBars, sessionDate).at(-1) ?? null;
      }
      metrics[`indicator.${condition.indicator}.${condition.period}`] = value;
    }
  }
}

async function futuresMetrics(alert: Alert, quote: Quote, provider: MarketDataProvider): Promise<AlertMetrics> {
  const root = parseFuturesSymbolSafe(alert.symbol);
  if (!root) return {};
  const spec = getFuturesRoot(root);
  const [contracts, curve] = await Promise.all([
    provider.getFuturesContracts(root),
    provider.getFuturesCurve(root),
  ]);
  const contract = contracts.find((item) => item.symbol.toUpperCase() === alert.symbol);
  const current = curve.find((point) => point.contract.symbol.toUpperCase() === alert.symbol);
  const front = curve[0];
  const next = curve[1];
  const currentPrice = quote.settle ?? quote.last ?? current?.quote.last;
  const frontPrice = front?.quote.settle ?? front?.quote.last;
  const nextPrice = next?.quote.settle ?? next?.quote.last;
  const days = contract ? daysToExpiry(contract) : null;
  return {
    "futures.price": currentPrice ?? null,
    "futures.spread": frontPrice === null || frontPrice === undefined || nextPrice === null || nextPrice === undefined
      ? null : nextPrice - frontPrice,
    "futures.basis": currentPrice === null || currentPrice === undefined || frontPrice === null || frontPrice === undefined
      ? null : currentPrice - frontPrice,
    "futures.daysToExpiry": days,
    "futures.daysToRoll": days === null ? null : days - spec.rollDays,
  };
}

async function evaluatePortfolioAlerts(): Promise<void> {
  const alerts = activeAlerts.filter((alert) => alert.assetClass === "portfolio");
  if (!alerts.length) return;
  const users = [...new Set(alerts.map((alert) => alert.userId))];
  for (const userId of users) {
    const matching = alerts.filter((alert) => alert.userId === userId &&
      (!alert.onlyRegularHours || isRegularUsSession(new Date())));
    try {
      const metrics = await buildPortfolioMetrics(userId);
      for (const alert of matching) {
        const { event } = await evaluateAndRecordAlert(userId, alert.id, metrics);
        if (event) await deliverOnce(userId, event);
      }
    } catch (error) {
      console.error(`[alerts:worker] Portfolio evaluation failed for ${userId}: ${errorMessage(error)}`);
    }
  }
}

async function buildPortfolioMetrics(userId: string): Promise<AlertMetrics> {
  const data = await getPositionsData(userId);
  const { positions } = foldTransactions(data.transactions, data.account.lotMethod);
  const openPositions = positions.filter((position) => position.quantity !== 0);
  if (!openPositions.length) return {
    "portfolio.dayPnl": 0,
    "portfolio.unrealizedPnl": 0,
    "portfolio.netDelta": 0,
    "portfolio.grossExposure": 0,
    "portfolio.concentration": 0,
  };
  const provider = getMarketDataProvider();
  const quotes = await provider.getQuote([...new Set(openPositions.map((position) =>
    position.assetClass === "option" ? position.underlying : position.symbol,
  ))]);
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol.toUpperCase(), quote]));
  const optionGroups = new Map<string, { underlying: string; expiry: string }>();
  for (const position of openPositions.filter((item) => item.assetClass === "option")) {
    const contract = parseOccSymbol(position.symbol);
    optionGroups.set(`${contract.underlying}:${contract.expiry}`, {
      underlying: contract.underlying,
      expiry: contract.expiry,
    });
  }
  const chains = await Promise.all([...optionGroups.values()].map((group) =>
    provider.getOptionChain(group.underlying, group.expiry),
  ));
  const optionBySymbol = new Map(chains.flat().map((item) => [item.contract.occSymbol, item.quote]));
  const futureDays = new Map<string, number>();
  for (const root of new Set(openPositions.filter((item) => item.assetClass === "future").map((item) => item.underlying))) {
    for (const contract of await provider.getFuturesContracts(root)) {
      futureDays.set(contract.symbol.toUpperCase(), daysToExpiry(contract));
    }
  }
  const valued = openPositions.map((position) => {
    const rawQuote = quoteBySymbol.get((position.assetClass === "option" ? position.underlying : position.symbol).toUpperCase());
    const rawOption = position.assetClass === "option" ? optionBySymbol.get(position.symbol) : undefined;
    const quote = rawQuote && acceptsMarketUpdate({
      value: quoteMark(rawQuote),
      updatedAt: rawQuote.updatedAt,
    }) ? rawQuote : undefined;
    const option = rawOption && acceptsMarketUpdate({
      value: optionQuoteMark(rawOption),
      updatedAt: rawOption.updatedAt,
    }) ? rawOption : undefined;
    const underlyingMark = quote ? quoteMark(quote) : null;
    return valuePosition(position, {
      mark: option ? optionQuoteMark(option) : underlyingMark,
      previousClose: position.assetClass === "future" ? quote?.prevSettle ?? quote?.prevClose ?? null : quote?.prevClose ?? null,
      underlyingMark: position.assetClass === "option" ? underlyingMark : null,
      optionQuote: option,
      futureDaysToExpiry: futureDays.get(position.symbol.toUpperCase()) ?? null,
      fxRate: position.currency === data.account.baseCurrency ? 1 : data.account.fxRates[position.currency] ?? 1,
    });
  });
  const fx = (currency: string) => currency === data.account.baseCurrency ? 1 : data.account.fxRates[currency] ?? 1;
  const grossExposure = valued.reduce((sum, position) => sum + Math.abs(position.baseMarketValue ?? 0), 0);
  const byUnderlying = new Map<string, number>();
  for (const position of valued) {
    byUnderlying.set(position.underlying, (byUnderlying.get(position.underlying) ?? 0) + Math.abs(position.baseMarketValue ?? 0));
  }
  const equityDelta = openPositions.reduce((sum, position) =>
    position.assetClass === "equity" ? sum + position.quantity : sum, 0);
  return {
    "portfolio.dayPnl": valued.some((position) => position.dayPnl === null)
      ? null : valued.reduce((sum, position) => sum + (position.dayPnl ?? 0) * fx(position.currency), 0),
    "portfolio.unrealizedPnl": valued.some((position) => position.unrealizedPnl === null)
      ? null : valued.reduce((sum, position) => sum + (position.unrealizedPnl ?? 0) * fx(position.currency), 0),
    "portfolio.netDelta": equityDelta + valued.reduce((sum, position) => sum + (position.delta ?? 0), 0),
    "portfolio.grossExposure": grossExposure,
    "portfolio.concentration": grossExposure ? (Math.max(...byUnderlying.values()) / grossExposure) * 100 : 0,
  };
}

function leavesOf(condition: AlertCondition): AlertLeafCondition[] {
  return condition.type === "and" ? condition.conditions : [condition];
}

function shouldEvaluateForTick(alert: Alert, updatedAt: string): boolean {
  const hasClosedBarIndicator = leavesOf(alert.condition).some(
    (condition) => condition.type === "indicator" && !condition.intrabar,
  );
  if (!hasClosedBarIndicator) return true;
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return false;
  const bucket = Math.floor(updated / 60_000);
  if (lastIndicatorBucket.get(alert.id) === bucket) return false;
  lastIndicatorBucket.set(alert.id, bucket);
  return true;
}

function isRegularUsSession(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? "";
  const weekday = part("weekday");
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  return weekday !== "Sat" && weekday !== "Sun" && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function optionQuoteAsQuote(option: OptionQuote, mark: number | null): Quote {
  return {
    symbol: option.occSymbol,
    name: option.occSymbol,
    type: "option",
    last: option.last ?? mark ?? 0,
    change: 0,
    changePercent: 0,
    bid: option.bid ?? 0,
    ask: option.ask ?? 0,
    volume: option.volume,
    dayLow: mark ?? option.last ?? 0,
    dayHigh: mark ?? option.last ?? 0,
    weekLow: mark ?? option.last ?? 0,
    weekHigh: mark ?? option.last ?? 0,
    updatedAt: option.updatedAt,
  };
}

function parseFuturesSymbolSafe(symbol: string): string | null {
  try {
    return parseFuturesSymbol(symbol).root;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown worker error.";
}

process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

void run().catch((error: unknown) => {
  console.error(`[alerts:worker] Fatal error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
