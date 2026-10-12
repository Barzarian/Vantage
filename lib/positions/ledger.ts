import { parseOccSymbol } from "@/lib/greeks/occ";
import { futuresRootFromSymbol } from "@/lib/futures/contracts";
import { getFuturesRoot } from "@/lib/futures/specs";
import {
  fromMinorUnits,
  toMinorUnits,
  transactionSchema,
  type FoldResult,
  type Position,
  type PositionTransaction,
  type RealizedEvent,
} from "./model";
import type { z } from "zod";
import type { lotMethodSchema } from "./model";

type LotMethod = z.infer<typeof lotMethodSchema>;
type Lot = { quantity: number; basisCents: number };
type MutablePosition = {
  accountId: string;
  symbol: string;
  assetClass: Position["assetClass"];
  underlying: string;
  currency: string;
  currencySet: boolean;
  lots: Lot[];
  realizedCents: number;
  disposition?: Position["disposition"];
};

export function multiplierForInstrument(symbol: string, assetClass: Position["assetClass"]): number {
  if (assetClass === "equity") return 1;
  if (assetClass === "option") return parseOccSymbol(symbol).multiplier;
  const root = futuresRootFromSymbol(symbol);
  return getFuturesRoot(root).multiplier;
}

export function foldTransactions(
  input: PositionTransaction[],
  lotMethod: LotMethod = "fifo",
): FoldResult {
  const transactions = input.map((transaction) => transactionSchema.parse(transaction))
    .sort((a, b) => a.executedAt.localeCompare(b.executedAt) || a.id.localeCompare(b.id));
  const states = new Map<string, MutablePosition>();
  const realizedEvents: RealizedEvent[] = [];

  const getState = (transaction: PositionTransaction): MutablePosition => {
    const key = `${transaction.accountId}:${transaction.assetClass}:${transaction.symbol}`;
    let state = states.get(key);
    if (!state) {
      const underlying = transaction.assetClass === "option"
        ? parseOccSymbol(transaction.symbol).underlying
        : transaction.assetClass === "future"
          ? futuresRootFromSymbol(transaction.symbol)
          : transaction.symbol;
      state = {
        accountId: transaction.accountId,
        symbol: transaction.symbol,
        assetClass: transaction.assetClass,
        underlying,
        currency: transaction.kind === "trade" || transaction.kind === "dividend" ? transaction.currency : "USD",
        currencySet: transaction.kind === "trade" || transaction.kind === "dividend",
        lots: [],
        realizedCents: 0,
      };
      states.set(key, state);
    }
    if (transaction.kind === "trade" || transaction.kind === "dividend") {
      if (state.currencySet && state.currency !== transaction.currency) {
        throw new RangeError(`A position cannot mix currencies: ${transaction.symbol}.`);
      }
      state.currency = transaction.currency;
      state.currencySet = true;
    }
    return state;
  };

  for (const transaction of transactions) {
    const state = getState(transaction);
    if (transaction.kind === "option-outcome") {
      if (transaction.disposition === "active") delete state.disposition;
      else state.disposition = transaction.disposition;
      continue;
    }
    if (transaction.kind === "split") {
      for (const lot of state.lots) lot.quantity *= transaction.ratioNumerator / transaction.ratioDenominator;
      continue;
    }
    if (transaction.kind === "dividend") {
      const quantity = state.lots.reduce((total, lot) => total + lot.quantity, 0);
      const amount = toMinorUnits(transaction.amountPerShare * quantity);
      state.realizedCents += amount;
      if (amount !== 0) realizedEvents.push({
        symbol: state.symbol,
        executedAt: transaction.executedAt,
        amount: fromMinorUnits(amount),
        transactionId: transaction.id,
      });
      continue;
    }

    const multiplier = multiplierForInstrument(transaction.symbol, transaction.assetClass);
    const signedQuantity = transaction.side === "buy" ? transaction.quantity : -transaction.quantity;
    const direction = Math.sign(signedQuantity);
    const totalFees = toMinorUnits(transaction.fees);
    let remainingQuantity = transaction.quantity;
    let matchedQuantity = 0;
    let tradePnlCents = 0;

    while (remainingQuantity > 0 && state.lots.length > 0 && Math.sign(state.lots[0]!.quantity) !== direction) {
      const lotIndex = lotMethod === "lifo" ? state.lots.length - 1 : 0;
      const lot = state.lots[lotIndex]!;
      const matched = Math.min(remainingQuantity, Math.abs(lot.quantity));
      const basisPart = matched === Math.abs(lot.quantity)
        ? lot.basisCents
        : Math.round(lot.basisCents * matched / Math.abs(lot.quantity));
      const gross = toMinorUnits(transaction.price * matched * multiplier);
      tradePnlCents += lot.quantity > 0 ? gross - basisPart : basisPart - gross;
      matchedQuantity += matched;
      lot.quantity += direction * matched;
      lot.basisCents -= basisPart;
      remainingQuantity -= matched;
      if (Math.abs(lot.quantity) < 1e-10) state.lots.splice(lotIndex, 1);
    }

    const closingFees = Math.round(totalFees * matchedQuantity / transaction.quantity);
    const openingFees = totalFees - closingFees;
    state.realizedCents += tradePnlCents - closingFees;
    if (remainingQuantity > 0) {
      const gross = toMinorUnits(transaction.price * remainingQuantity * multiplier);
      const basisCents = direction > 0 ? gross + openingFees : gross - openingFees;
      if (lotMethod === "average" && state.lots.length > 0) {
        state.lots[0]!.quantity += direction * remainingQuantity;
        state.lots[0]!.basisCents += basisCents;
      } else {
        state.lots.push({ quantity: direction * remainingQuantity, basisCents });
      }
    }
    const realizedTradeAmount = tradePnlCents - Math.round(totalFees * matchedQuantity / transaction.quantity);
    if (matchedQuantity > 0 && realizedTradeAmount !== 0) {
      realizedEvents.push({
        symbol: state.symbol,
        executedAt: transaction.executedAt,
        amount: fromMinorUnits(realizedTradeAmount),
        transactionId: transaction.id,
      });
    }
  }

  const positions = [...states.values()].map((state): Position => {
    const quantity = state.lots.reduce((total, lot) => total + lot.quantity, 0);
    const basisCents = state.lots.reduce((total, lot) => total + lot.basisCents, 0);
    const costBasis = fromMinorUnits(basisCents);
    const multiplier = multiplierForInstrument(state.symbol, state.assetClass);
    return {
      accountId: state.accountId,
      symbol: state.symbol,
      assetClass: state.assetClass,
      underlying: state.underlying,
      quantity,
      averageCost: quantity === 0 ? 0 : costBasis / (Math.abs(quantity) * multiplier),
      costBasis,
      realizedPnl: fromMinorUnits(state.realizedCents),
      currency: state.currency,
      ...(state.disposition ? { disposition: state.disposition } : {}),
    };
  });

  return {
    positions: positions.filter((position) => position.quantity !== 0 || position.realizedPnl !== 0 || position.disposition),
    realizedEvents: realizedEvents.sort((a, b) => a.executedAt.localeCompare(b.executedAt)),
  };
}
