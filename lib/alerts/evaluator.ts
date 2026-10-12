import type { Alert, AlertCondition, AlertEvaluationState, AlertLeafCondition, AlertTriggerMode } from "./model";

export type AlertMetrics = Partial<Record<
  | "price.last"
  | "price.mid"
  | "price.bid"
  | "price.ask"
  | "percent-change"
  | `percent-change.${number}`
  | "volume-spike"
  | `volume-spike.${number}`
  | "indicator"
  | `indicator.${string}.${number}`
  | "option.mid"
  | "option.impliedVolatility"
  | "option.delta"
  | "option.gamma"
  | "option.theta"
  | "option.vega"
  | "option.volume"
  | "option.openInterest"
  | "futures.price"
  | "futures.spread"
  | "futures.basis"
  | "futures.daysToExpiry"
  | "futures.daysToRoll"
  | "portfolio.dayPnl"
  | "portfolio.unrealizedPnl"
  | "portfolio.netDelta"
  | "portfolio.grossExposure"
  | "portfolio.concentration",
  number | null
>>;

export type AlertEvaluation = {
  matches: boolean;
  shouldTrigger: boolean;
  value: number | null;
  state: AlertEvaluationState;
  reason: string;
};

export function evaluateAlert(
  condition: AlertCondition,
  metrics: AlertMetrics,
  state: AlertEvaluationState,
  triggerMode: AlertTriggerMode,
  cooldownSeconds: number,
  now = new Date(),
): AlertEvaluation {
  const nextPrevious = { ...state.previousValues };
  const matchedValues: number[] = [];
  const checks = condition.type === "and" ? condition.conditions : [condition];
  const results = checks.map((leaf) => {
    const result = evaluateLeaf(leaf, metrics, nextPrevious);
    if (result.value !== null) matchedValues.push(result.value);
    return result.matches;
  });
  const matches = results.every(Boolean) && results.length > 0;
  const crossed = matches && !state.previousValues.__matched;
  const isCooldownReady = !state.lastTriggeredAt ||
    now.getTime() - Date.parse(state.lastTriggeredAt) >= cooldownSeconds * 1000;
  const shouldTrigger = matches && (
    triggerMode === "once" ? !state.fired :
    triggerMode === "every-cross" ? crossed :
    isCooldownReady
  );
  nextPrevious.__matched = matches ? 1 : 0;
  const value = matchedValues.length
    ? matchedValues.reduce((sum, item) => sum + item, 0) / matchedValues.length
    : null;
  return {
    matches,
    shouldTrigger,
    value,
    state: {
      previousValues: nextPrevious,
      lastTriggeredAt: shouldTrigger ? now.toISOString() : state.lastTriggeredAt,
      fired: state.fired || (shouldTrigger && triggerMode === "once"),
    },
    reason: matches ? "Condition met." : "Condition not met.",
  };
}

export function emptyAlertEvaluationState(): AlertEvaluationState {
  return { previousValues: {}, lastTriggeredAt: null, fired: false };
}

export function acceptsMarketUpdate(input: {
  value: number | null | undefined;
  updatedAt: string;
  previousValue?: number | null;
  maxAgeSeconds?: number;
  maxJumpPercent?: number;
  now?: Date;
}): boolean {
  const value = input.value;
  const updated = Date.parse(input.updatedAt);
  const now = input.now ?? new Date();
  const maxAgeMs = (input.maxAgeSeconds ?? 30) * 1000;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 ||
      !Number.isFinite(updated) || updated > now.getTime() + 5_000 ||
      now.getTime() - updated > maxAgeMs) return false;
  if (input.previousValue !== undefined && input.previousValue !== null) {
    if (!Number.isFinite(input.previousValue) || input.previousValue <= 0) return false;
    const jumpPercent = Math.abs((value - input.previousValue) / input.previousValue) * 100;
    if (jumpPercent > (input.maxJumpPercent ?? 20)) return false;
  }
  return true;
}

export function alertSummary(alert: Pick<Alert, "name" | "symbol">, value: number | null): string {
  const at = value === null ? "" : ` at ${formatValue(value)}`;
  return `${alert.name} triggered for ${alert.symbol}${at}.`;
}

function evaluateLeaf(
  condition: AlertLeafCondition,
  metrics: AlertMetrics,
  previous: Record<string, number>,
): { matches: boolean; value: number | null } {
  const key = JSON.stringify(condition);
  const value = metricFor(condition, metrics);
  const was = previous[key];
  if (value !== null && Number.isFinite(value)) previous[key] = value;
  if (value === null || !Number.isFinite(value)) return { matches: false, value: null };
  switch (condition.comparison) {
    case "above": return { matches: value >= condition.threshold, value };
    case "below": return { matches: value <= condition.threshold, value };
    case "crosses-above": return { matches: was !== undefined && was < condition.threshold && value >= condition.threshold, value };
    case "crosses-below": return { matches: was !== undefined && was > condition.threshold && value <= condition.threshold, value };
  }
}

function metricFor(condition: AlertLeafCondition, metrics: AlertMetrics): number | null {
  let key: keyof AlertMetrics;
  let conditionKey: keyof AlertMetrics | null = null;
  switch (condition.type) {
    case "price": key = `price.${condition.source}`; break;
    case "percent-change":
      key = "percent-change";
      conditionKey = `percent-change.${condition.windowMinutes}`;
      break;
    case "volume-spike":
      key = "volume-spike";
      conditionKey = `volume-spike.${condition.lookbackMinutes}`;
      break;
    case "indicator":
      key = "indicator";
      conditionKey = `indicator.${condition.indicator}.${condition.period}`;
      break;
    case "option": key = `option.${condition.metric}`; break;
    case "futures": key = `futures.${condition.metric}`; break;
    case "portfolio": key = `portfolio.${condition.metric}`; break;
  }
  const value = conditionKey && Object.hasOwn(metrics, conditionKey)
    ? metrics[conditionKey]
    : metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatValue(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}
