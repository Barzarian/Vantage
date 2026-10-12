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

export const futuresContractSchema = z.object({
  symbol: z.string(),
  expiry: z.string(),
  last: z.number().finite(),
  daysToExpiry: z.number().int().nonnegative(),
});
export type FuturesContract = z.infer<typeof futuresContractSchema>;

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
