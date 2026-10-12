import { z } from "zod";
import { parseFuturesSymbol } from "@/lib/futures/contracts";
import { findFuturesRoot } from "@/lib/futures/specs";
import { parseOccSymbol } from "@/lib/greeks/occ";

export const assetClassSchema = z.enum(["equity", "option", "future"]);
export const lotMethodSchema = z.enum(["fifo", "lifo", "average"]);
export const optionDispositionSchema = z.enum(["active", "expired", "assigned", "exercised"]);

const baseTransactionSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  symbol: z.string().trim().min(1).transform((symbol) => symbol.toUpperCase()),
  assetClass: assetClassSchema,
  executedAt: z.string().datetime(),
  notes: z.string().max(2_000).default(""),
});

const tradeSchema = baseTransactionSchema.extend({
  kind: z.literal("trade").default("trade"),
  side: z.enum(["buy", "sell"]),
  quantity: z.number().positive().finite(),
  price: z.number().nonnegative().finite(),
  fees: z.number().nonnegative().finite().default(0),
  currency: z.string().trim().length(3).default("USD").transform((currency) => currency.toUpperCase()),
  openClose: z.enum(["open", "close"]).optional(),
});

const splitSchema = baseTransactionSchema.extend({
  kind: z.literal("split"),
  assetClass: z.literal("equity"),
  ratioNumerator: z.number().positive().finite(),
  ratioDenominator: z.number().positive().finite(),
});

const dividendSchema = baseTransactionSchema.extend({
  kind: z.literal("dividend"),
  assetClass: z.literal("equity"),
  amountPerShare: z.number().finite(),
  currency: z.string().trim().length(3).default("USD").transform((currency) => currency.toUpperCase()),
});

const optionOutcomeSchema = baseTransactionSchema.extend({
  kind: z.literal("option-outcome"),
  assetClass: z.literal("option"),
  disposition: optionDispositionSchema,
});

export const transactionSchema = z.discriminatedUnion("kind", [
  tradeSchema.extend({ kind: z.literal("trade") }),
  splitSchema,
  dividendSchema,
  optionOutcomeSchema,
]).superRefine(validateTransactionInstrument);
export type PositionTransaction = z.infer<typeof transactionSchema>;
export type TradeTransaction = z.infer<typeof tradeSchema>;
export const transactionInputSchema = z.discriminatedUnion("kind", [
  tradeSchema.omit({ id: true }).extend({ kind: z.literal("trade") }),
  splitSchema.omit({ id: true }),
  dividendSchema.omit({ id: true }),
  optionOutcomeSchema.omit({ id: true }),
]).superRefine(validateTransactionInstrument);
export type PositionTransactionInput = z.infer<typeof transactionInputSchema>;

export const accountSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  baseCurrency: z.string().trim().length(3).default("USD").transform((currency) => currency.toUpperCase()),
  fxRates: z.record(z.string().length(3), z.number().positive().finite()).default({}),
  cashBalance: z.number().finite().default(0),
  lotMethod: lotMethodSchema.default("fifo"),
  expiryWarningDays: z.number().int().min(0).max(365).default(7),
  concentrationThreshold: z.number().positive().max(1).default(0.25),
});
export type PositionAccount = z.infer<typeof accountSchema>;
export const accountSettingsSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  baseCurrency: z.string().trim().length(3).transform((currency) => currency.toUpperCase()).optional(),
  fxRates: z.record(z.string().length(3), z.number().positive().finite()).optional(),
  cashBalance: z.number().finite().optional(),
  lotMethod: lotMethodSchema.optional(),
  expiryWarningDays: z.number().int().min(0).max(365).optional(),
  concentrationThreshold: z.number().positive().max(1).optional(),
}).refine((settings) => Object.keys(settings).length > 0, "At least one account setting is required.");
export type AccountSettings = z.infer<typeof accountSettingsSchema>;

export type RealizedEvent = {
  symbol: string;
  executedAt: string;
  amount: number;
  transactionId: string;
};

export type Position = {
  accountId: string;
  symbol: string;
  assetClass: z.infer<typeof assetClassSchema>;
  underlying: string;
  quantity: number;
  averageCost: number;
  costBasis: number;
  realizedPnl: number;
  currency: string;
  disposition?: z.infer<typeof optionDispositionSchema>;
};

export type FoldResult = {
  positions: Position[];
  realizedEvents: RealizedEvent[];
};

export const portfolioSnapshotSchema = z.object({
  accountId: z.string().min(1),
  snapshotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  marketValue: z.number().finite(),
  realizedPnl: z.number().finite(),
  unrealizedPnl: z.number().finite(),
  delta: z.number().finite(),
  gamma: z.number().finite(),
  theta: z.number().finite(),
  vega: z.number().finite(),
});
export type PortfolioSnapshot = z.infer<typeof portfolioSnapshotSchema>;
export const positionColumnsSchema = z.array(z.enum([
  "symbol", "assetClass", "quantity", "averageCost", "mark", "marketValue", "dayPnl",
  "unrealizedPnl", "delta", "portfolioWeight", "daysToExpiry",
])).min(1).max(11);
export const positionsPreferencesSchema = z.object({
  columns: positionColumnsSchema,
  sortBy: z.enum(["symbol", "marketValue", "dayPnl", "unrealizedPnl"]).default("symbol"),
});
export type PositionsPreferences = z.infer<typeof positionsPreferencesSchema>;

export function toMinorUnits(amount: number): number {
  if (!Number.isFinite(amount)) throw new RangeError("Money values must be finite.");
  return Math.round(amount * 100);
}

export function fromMinorUnits(amount: number): number {
  return amount / 100;
}

function validateTransactionInstrument(
  transaction: PositionTransaction | PositionTransactionInput,
  context: z.RefinementCtx,
) {
  try {
    if (transaction.assetClass === "option") parseOccSymbol(transaction.symbol);
    if (transaction.assetClass === "future") {
      const parsed = parseFuturesSymbol(transaction.symbol);
      if (!findFuturesRoot(parsed.root)) throw new RangeError(`Unknown futures root: ${parsed.root}.`);
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    context.addIssue({ code: "custom", path: ["symbol"], message: error.message });
  }
}
