import { describe, expect, it } from "vitest";
import { acceptsMarketUpdate, emptyAlertEvaluationState, evaluateAlert } from "@/lib/alerts/evaluator";
import { alertConditionSchema, type AlertCondition } from "@/lib/alerts/model";

describe("alert condition validation", () => {
  it("accepts AND conditions with two or three leaves only", () => {
    const leaf = { type: "price", source: "last", comparison: "above", threshold: 100 };
    expect(alertConditionSchema.safeParse({ type: "and", conditions: [leaf, leaf] }).success).toBe(true);
    expect(alertConditionSchema.safeParse({ type: "and", conditions: [leaf, leaf, leaf] }).success).toBe(true);
    expect(alertConditionSchema.safeParse({ type: "and", conditions: [leaf] }).success).toBe(false);
    expect(alertConditionSchema.safeParse({ type: "and", conditions: [leaf, leaf, leaf, leaf] }).success).toBe(false);
    expect(alertConditionSchema.safeParse({ type: "and", conditions: [{ type: "and", conditions: [leaf, leaf] }, leaf] }).success).toBe(false);
  });
});

describe("alert evaluator", () => {
  it("triggers a crossing once per false-to-true edge", () => {
    const condition = { type: "price", source: "last", comparison: "crosses-above", threshold: 10 } as const;
    const first = evaluateAlert(condition, { "price.last": 9 }, emptyAlertEvaluationState(), "every-cross", 30);
    expect(first.shouldTrigger).toBe(false);
    const state = evaluateAlert(condition, { "price.last": 11 }, first.state, "every-cross", 30);
    expect(state.shouldTrigger).toBe(true);
    const repeated = evaluateAlert(condition, { "price.last": 12 }, state.state, "every-cross", 30);
    expect(repeated.shouldTrigger).toBe(false);
  });

  it("handles level triggers, cooldown, and one-shot mode", () => {
    const condition = { type: "portfolio", metric: "dayPnl", comparison: "below", threshold: -100 } as const;
    const now = new Date("2025-01-01T00:00:00Z");
    const once = evaluateAlert(condition, { "portfolio.dayPnl": -120 }, emptyAlertEvaluationState(), "once", 30, now);
    expect(once.shouldTrigger).toBe(true);
    expect(evaluateAlert(condition, { "portfolio.dayPnl": -130 }, once.state, "once", 30, now).shouldTrigger).toBe(false);
    const cooldown = evaluateAlert(condition, { "portfolio.dayPnl": -120 }, emptyAlertEvaluationState(), "cooldown", 60, now);
    expect(cooldown.shouldTrigger).toBe(true);
    expect(evaluateAlert(condition, { "portfolio.dayPnl": -130 }, cooldown.state, "cooldown", 60, new Date(now.getTime() + 30_000)).shouldTrigger).toBe(false);
    expect(evaluateAlert(condition, { "portfolio.dayPnl": -130 }, cooldown.state, "cooldown", 60, new Date(now.getTime() + 60_000)).shouldTrigger).toBe(true);
  });

  it("requires every AND component to match", () => {
    const condition: AlertCondition = {
      type: "and",
      conditions: [
        { type: "price", source: "last", comparison: "above", threshold: 10 },
        { type: "percent-change", comparison: "above", threshold: 2, windowMinutes: 5 },
      ],
    };
    expect(evaluateAlert(condition, { "price.last": 12, "percent-change": 1 }, emptyAlertEvaluationState(), "every-cross", 30).matches).toBe(false);
    expect(evaluateAlert(condition, { "price.last": 12, "percent-change": 3 }, emptyAlertEvaluationState(), "every-cross", 30).matches).toBe(true);
  });

  it("uses distinct lookback and indicator values for compound conditions", () => {
    const condition: AlertCondition = {
      type: "and",
      conditions: [
        { type: "percent-change", comparison: "above", threshold: 1, windowMinutes: 1 },
        { type: "percent-change", comparison: "above", threshold: 2, windowMinutes: 5 },
        { type: "indicator", indicator: "rsi", comparison: "above", threshold: 50, period: 14, intrabar: false },
      ],
    };
    const result = evaluateAlert(condition, {
      "percent-change.1": 3,
      "percent-change.5": 1.5,
      "percent-change": 10,
      "indicator.rsi.14": 55,
      indicator: 10,
    }, emptyAlertEvaluationState(), "every-cross", 30);
    expect(result.matches).toBe(false);
  });

  it("rejects stale, invalid, future-dated, and discontinuous market updates", () => {
    const now = new Date("2025-01-01T00:00:00Z");
    expect(acceptsMarketUpdate({ value: 10, updatedAt: now.toISOString(), now })).toBe(true);
    expect(acceptsMarketUpdate({ value: 10, updatedAt: new Date(now.getTime() - 31_000).toISOString(), now })).toBe(false);
    expect(acceptsMarketUpdate({ value: Number.NaN, updatedAt: now.toISOString(), now })).toBe(false);
    expect(acceptsMarketUpdate({ value: 10, updatedAt: new Date(now.getTime() + 10_000).toISOString(), now })).toBe(false);
    expect(acceptsMarketUpdate({ value: 20, previousValue: 10, updatedAt: now.toISOString(), now })).toBe(false);
  });
});
