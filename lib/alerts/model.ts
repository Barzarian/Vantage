import { z } from "zod";

export const alertComparisonSchema = z.enum(["above", "below", "crosses-above", "crosses-below"]);
export type AlertComparison = z.infer<typeof alertComparisonSchema>;

const conditionBase = {
  comparison: alertComparisonSchema,
  threshold: z.number().finite(),
};

export const alertLeafConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("price"),
    source: z.enum(["last", "mid", "bid", "ask"]).default("mid"),
    ...conditionBase,
  }),
  z.object({
    type: z.literal("percent-change"),
    windowMinutes: z.number().int().min(1).max(1440).default(1),
    ...conditionBase,
  }),
  z.object({
    type: z.literal("volume-spike"),
    lookbackMinutes: z.number().int().min(5).max(1440).default(30),
    comparison: alertComparisonSchema.default("above"),
    threshold: z.number().positive().finite().default(2),
  }),
  z.object({
    type: z.literal("indicator"),
    indicator: z.enum(["rsi", "sma", "ema", "macd", "vwap"]),
    period: z.number().int().min(2).max(250).default(14),
    comparison: alertComparisonSchema,
    threshold: z.number().finite(),
    intrabar: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("option"),
    metric: z.enum(["mid", "impliedVolatility", "delta", "gamma", "theta", "vega", "volume", "openInterest"]),
    comparison: alertComparisonSchema,
    threshold: z.number().finite(),
  }),
  z.object({
    type: z.literal("futures"),
    metric: z.enum(["price", "spread", "basis", "daysToExpiry", "daysToRoll"]),
    comparison: alertComparisonSchema,
    threshold: z.number().finite(),
  }),
  z.object({
    type: z.literal("portfolio"),
    metric: z.enum(["dayPnl", "unrealizedPnl", "netDelta", "grossExposure", "concentration"]),
    comparison: alertComparisonSchema,
    threshold: z.number().finite(),
  }),
]);
export type AlertLeafCondition = z.infer<typeof alertLeafConditionSchema>;

export const alertConditionSchema = z.union([
  alertLeafConditionSchema,
  z.object({
    type: z.literal("and"),
    conditions: z.array(alertLeafConditionSchema).min(2).max(3),
  }),
]);
export type AlertCondition = z.infer<typeof alertConditionSchema>;

export const alertAssetClassSchema = z.enum(["equity", "option", "future", "portfolio"]);
export type AlertAssetClass = z.infer<typeof alertAssetClassSchema>;
export const alertTriggerModeSchema = z.enum(["once", "every-cross", "cooldown"]);
export type AlertTriggerMode = z.infer<typeof alertTriggerModeSchema>;

export const alertInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  symbol: z.string().trim().min(1).max(32).transform((value) => value.toUpperCase()),
  assetClass: alertAssetClassSchema,
  condition: alertConditionSchema,
  triggerMode: alertTriggerModeSchema.default("every-cross"),
  cooldownSeconds: z.number().int().min(30).max(604800).default(300),
  active: z.boolean().default(true),
  onlyRegularHours: z.boolean().default(false),
  maxJumpPercent: z.number().positive().max(1000).default(20),
});
export type AlertInput = z.infer<typeof alertInputSchema>;
export const alertActiveSchema = z.object({ active: z.boolean() }).strict();

export const alertEvaluationStateSchema = z.object({
  previousValues: z.record(z.string(), z.number().finite()).default({}),
  lastTriggeredAt: z.string().datetime().nullable().default(null),
  fired: z.boolean().default(false),
});
export type AlertEvaluationState = z.infer<typeof alertEvaluationStateSchema>;

export const alertSchema = alertInputSchema.extend({
  id: z.string().min(1),
  userId: z.string().min(1),
  lastTriggeredAt: z.string().datetime().nullable(),
  lastEvaluatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  evaluationState: alertEvaluationStateSchema,
});
export type Alert = z.infer<typeof alertSchema>;

export const alertEventSchema = z.object({
  id: z.string().min(1),
  alertId: z.string().min(1),
  userId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  triggerValue: z.number().finite().nullable(),
  summary: z.string().min(1),
  deliveryResults: z.record(z.string(), z.object({
    status: z.enum(["delivered", "failed", "skipped"]),
    message: z.string().optional(),
    attemptedAt: z.string().datetime(),
  })),
  readAt: z.string().datetime().nullable(),
  triggeredAt: z.string().datetime(),
});
export type AlertEvent = z.infer<typeof alertEventSchema>;

export const notificationChannelTypeSchema = z.enum(["in-app", "email", "push", "webhook"]);
export type NotificationChannelType = z.infer<typeof notificationChannelTypeSchema>;

export const notificationChannelInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("in-app"),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("email"),
    enabled: z.boolean(),
    email: z.string().email().max(254),
  }),
  z.object({
    type: z.literal("push"),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("webhook"),
    enabled: z.boolean(),
    url: z.string().url().max(2048),
    secret: z.string().min(32).max(256),
  }),
]);
export type NotificationChannelInput = z.infer<typeof notificationChannelInputSchema>;

export const notificationChannelToggleSchema = z.object({
  type: notificationChannelTypeSchema,
  enabled: z.boolean(),
});
export type NotificationChannelToggle = z.infer<typeof notificationChannelToggleSchema>;

export const alertFilterSchema = z.object({
  status: z.enum(["all", "active", "paused"]).default("all"),
  symbol: z.string().trim().max(32).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  expirationTime: z.number().finite().nullable(),
  keys: z.object({
    p256dh: z.string().min(16).max(512),
    auth: z.string().min(8).max(256),
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
