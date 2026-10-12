import { NextResponse } from "next/server";
import { daysToExpiry } from "@/lib/futures/contracts";
import { parseOccSymbol } from "@/lib/greeks/occ";
import { getMarketDataProvider } from "@/lib/market-data";
import { foldTransactions } from "@/lib/positions/ledger";
import { getPositionsData, savePortfolioSnapshot } from "@/lib/positions/service";
import { isOptionExpired, optionQuoteMark, quoteMark, valuePosition } from "@/lib/positions/valuation";
import { authenticationErrorResponse, requireCurrentUserId } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const userId = await requireCurrentUserId();
    const { account, transactions } = await getPositionsData(userId);
    const { positions } = foldTransactions(transactions, account.lotMethod);
    const provider = getMarketDataProvider();
    const quoteSymbols = [...new Set(positions.flatMap((position) =>
      position.assetClass === "option" ? [position.underlying] : [position.symbol],
    ))];
    const quotes = quoteSymbols.length ? await provider.getQuote(quoteSymbols) : [];
    const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol.toUpperCase(), quote]));
    const now = new Date();
    const activeOptions = positions.filter((position) => position.assetClass === "option" &&
      !isOptionExpired(parseOccSymbol(position.symbol).expiry, now));
    const optionGroups = new Map<string, { underlying: string; expiry: string }>();
    for (const position of activeOptions) {
      const contract = parseOccSymbol(position.symbol);
      optionGroups.set(`${contract.underlying}:${contract.expiry}`, { underlying: contract.underlying, expiry: contract.expiry });
    }
    const optionChains = await Promise.all([...optionGroups.values()].map(({ underlying, expiry }) =>
      provider.getOptionChain(underlying, expiry),
    ));
    const optionBySymbol = new Map(optionChains.flat().map((item) => [item.contract.occSymbol, item.quote]));
    const futuresRoots = [...new Set(positions.filter((position) => position.assetClass === "future").map((position) => position.underlying))];
    const futureContracts = new Map<string, number | null>();
    for (const root of futuresRoots) {
      const contracts = await provider.getFuturesContracts(root);
      for (const contract of contracts) futureContracts.set(contract.symbol.toUpperCase(), daysToExpiry(contract, now));
    }

    const valued = positions.map((position) => {
      const underlyingQuote = quoteBySymbol.get(position.underlying.toUpperCase());
      const quote = position.assetClass === "option" ? underlyingQuote : quoteBySymbol.get(position.symbol.toUpperCase());
      const option = position.assetClass === "option" ? optionBySymbol.get(position.symbol) : undefined;
      const optionMark = option ? optionQuoteMark(option) : null;
      const mark = position.assetClass === "option" ? optionMark : quote ? quoteMark(quote) : null;
      return valuePosition(position, {
        mark,
        previousClose: position.assetClass === "future"
          ? quote?.prevSettle ?? quote?.prevClose ?? null
          : position.assetClass === "equity" ? quote?.prevClose ?? null : null,
        underlyingMark: position.assetClass === "option" && underlyingQuote ? quoteMark(underlyingQuote) : null,
        optionQuote: option,
        futureDaysToExpiry: futureContracts.get(position.symbol.toUpperCase()) ?? null,
        fxRate: position.currency === account.baseCurrency ? 1 : account.fxRates[position.currency] ?? 1,
        asOf: now,
      });
    });
    const missingMarks = valued.filter((position) => position.baseMarketValue === null);
    if (missingMarks.length) {
      throw new Error(`Snapshot skipped because marks are missing for: ${missingMarks.map((position) => position.symbol).join(", ")}.`);
    }
    const fx = (currency: string) => currency === account.baseCurrency ? 1 : account.fxRates[currency] ?? 1;
    const dateParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const datePart = (type: Intl.DateTimeFormatPartTypes) => dateParts.find((part) => part.type === type)!.value;
    const snapshot = await savePortfolioSnapshot({
      accountId: account.id,
      snapshotDate: `${datePart("year")}-${datePart("month")}-${datePart("day")}`,
      marketValue: valued.reduce((total, position) => total + (position.baseMarketValue ?? 0), 0) + account.cashBalance,
      realizedPnl: valued.reduce((total, position) => total + position.realizedPnl * fx(position.currency), 0),
      unrealizedPnl: valued.reduce((total, position) => total + (position.unrealizedPnl ?? 0) * fx(position.currency), 0),
      delta: valued.reduce((total, position) => total + (position.delta ?? 0), 0),
      gamma: valued.reduce((total, position) => total + (position.gamma ?? 0), 0),
      theta: valued.reduce((total, position) => total + (position.theta ?? 0) * fx(position.currency), 0),
      vega: valued.reduce((total, position) => total + (position.vega ?? 0), 0),
    }, userId);
    return NextResponse.json({ snapshot });
  } catch (error) {
    const authResponse = authenticationErrorResponse(error);
    if (authResponse) return authResponse;
    const message = error instanceof Error ? error.message : "Snapshot job failed.";
    console.error(`[positions-snapshot] ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
