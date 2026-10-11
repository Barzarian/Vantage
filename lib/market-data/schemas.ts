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
  symbol: z.string(),
  expiry: z.string(),
  strike: z.number().positive(),
  side: z.enum(["call", "put"]),
  bid: z.number().nonnegative(),
  ask: z.number().nonnegative(),
  last: z.number().nonnegative(),
  volume: z.number().int().nonnegative(),
  openInterest: z.number().int().nonnegative(),
  impliedVolatility: z.number().nonnegative(),
  delta: z.number().finite().optional(),
  gamma: z.number().nonnegative().optional(),
  theta: z.number().finite().optional(),
  vega: z.number().nonnegative().optional(),
});
export type OptionContract = z.infer<typeof optionContractSchema>;

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
