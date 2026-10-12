import { z } from "zod";

export const instrumentTypeSchema = z.enum(["stock", "future", "option", "index"]);
export type InstrumentType = z.infer<typeof instrumentTypeSchema>;

export const quoteSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1),
  type: instrumentTypeSchema,
  last: z.number().finite(),
  change: z.number().finite(),
  changePercent: z.number().finite(),
  bid: z.number().finite(),
  ask: z.number().finite(),
  volume: z.number().int().nonnegative(),
  dayLow: z.number().finite(),
  dayHigh: z.number().finite(),
  weekLow: z.number().finite(),
  weekHigh: z.number().finite(),
  bidSize: z.number().nonnegative().optional(),
  askSize: z.number().nonnegative().optional(),
  lastSize: z.number().nonnegative().optional(),
  open: z.number().finite().optional(),
  prevClose: z.number().finite().optional(),
  settle: z.number().finite().nullable().optional(),
  prevSettle: z.number().finite().nullable().optional(),
  openInterest: z.number().int().nonnegative().nullable().optional(),
  dataType: z.enum(["realtime", "delayed", "frozen"]).optional(),
  updatedAt: z.string().datetime(),
});
export type Quote = z.infer<typeof quoteSchema>;

export const barSchema = z.object({
  time: z.number().int().positive(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().int().nonnegative(),
});
export type Bar = z.infer<typeof barSchema>;

export const optionContractSchema = z.object({
  occSymbol: z.string().min(8).max(32),
  underlying: z.string().min(1).max(16),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strike: z.number().positive().finite(),
  type: z.enum(["call", "put"]),
  multiplier: z.literal(100).default(100),
});
export type OptionContract = z.infer<typeof optionContractSchema>;

export const optionQuoteSchema = z.object({
  occSymbol: z.string().min(8).max(32),
  underlying: z.string().min(1).max(16),
  bid: z.number().nonnegative().finite().nullable(),
  ask: z.number().nonnegative().finite().nullable(),
  last: z.number().nonnegative().finite().nullable(),
  mark: z.number().nonnegative().finite().nullable(),
  volume: z.number().int().nonnegative(),
  openInterest: z.number().int().nonnegative(),
  impliedVolatility: z.number().nonnegative().finite().nullable(),
  delta: z.number().finite().nullable().optional(),
  gamma: z.number().finite().nullable().optional(),
  theta: z.number().finite().nullable().optional(),
  vega: z.number().finite().nullable().optional(),
  greeksSource: z.enum(["provider", "computed"]),
  updatedAt: z.string().datetime(),
});
export type OptionQuote = z.infer<typeof optionQuoteSchema>;

export const optionChainItemSchema = z.object({
  contract: optionContractSchema,
  quote: optionQuoteSchema,
});
export type OptionChainItem = z.infer<typeof optionChainItemSchema>;

export const optionExpiriesSchema = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

export const futuresSectorSchema = z.enum(["equity index", "energy", "metals", "rates", "grains", "FX"]);
export const futuresSettlementSchema = z.enum(["cash", "physical"]);
export const futuresMonthCodeSchema = z.enum(["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"]);
export const futuresRollRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("days-before-expiry"), days: z.number().int().min(0).max(90) }),
  z.object({ type: z.literal("volume-crossover") }),
  z.object({ type: z.literal("open-interest-crossover") }),
]);
export const futuresAdjustmentSchema = z.enum(["unadjusted", "ratio", "difference"]);

export const futuresRootSchema = z.object({
  root: z.string().min(1).max(8),
  name: z.string().min(1),
  exchange: z.string().min(1),
  currency: z.string().min(1),
  tickSize: z.number().positive().finite(),
  tickValue: z.number().positive().finite(),
  multiplier: z.number().positive().finite(),
  contractMonths: z.array(futuresMonthCodeSchema).min(1),
  tradingHours: z.string().min(1),
  settlement: futuresSettlementSchema,
  sector: futuresSectorSchema,
  approximateMargin: z.number().positive().finite(),
  rollDays: z.number().int().min(0).max(90).default(5),
});
export type FuturesRoot = z.infer<typeof futuresRootSchema>;

export const futuresContractSchema = z.object({
  symbol: z.string().min(2),
  root: z.string().min(1),
  monthCode: futuresMonthCodeSchema,
  year: z.number().int().min(1900).max(2200),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lastTradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  firstNoticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  isFront: z.boolean(),
});
export type FuturesContract = z.infer<typeof futuresContractSchema>;

export const futuresQuoteSchema = z.object({
  symbol: z.string().min(2),
  last: z.number().finite().nullable(),
  bid: z.number().finite().nullable(),
  ask: z.number().finite().nullable(),
  settle: z.number().finite().nullable(),
  prevSettle: z.number().finite().nullable(),
  volume: z.number().int().nonnegative().nullable(),
  openInterest: z.number().int().nonnegative().nullable(),
  change: z.number().finite().nullable(),
  lastUpdate: z.string().datetime(),
});
export type FuturesQuote = z.infer<typeof futuresQuoteSchema>;

export const futuresCurvePointSchema = z.object({
  contract: futuresContractSchema,
  quote: futuresQuoteSchema,
  daysToExpiry: z.number().int().nonnegative(),
  daysToFirstNotice: z.number().int().nonnegative().nullable(),
});
export type FuturesCurvePoint = z.infer<typeof futuresCurvePointSchema>;

export const futuresPreferenceSchema = z.object({
  adjustment: futuresAdjustmentSchema,
  rollRule: futuresRollRuleSchema,
  chartOverlays: z.array(z.enum(["SMA", "EMA", "VWAP", "Bollinger"])).max(8),
  lastRoot: z.string().max(8),
});
export type FuturesPreference = z.infer<typeof futuresPreferenceSchema>;

export const instrumentSearchResultSchema = z.object({
  conId: z.number().int().positive(),
  symbol: z.string().min(1),
  localSymbol: z.string().optional(),
  name: z.string(),
  secType: z.enum(["STK", "IND", "FUT"]),
  exchange: z.string(),
  primaryExchange: z.string().optional(),
  currency: z.string(),
  multiplier: z.string().optional(),
  lastTradeDate: z.string().optional(),
});
export type InstrumentSearchResult = z.infer<typeof instrumentSearchResultSchema>;

export const tickSchema = quoteSchema;
export type Tick = Quote;
